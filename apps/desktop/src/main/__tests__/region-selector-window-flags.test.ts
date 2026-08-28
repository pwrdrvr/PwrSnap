// Lifecycle pin for the region-selector overlay window construction.
//
// Background — Splashtop Space-shift bug (bug iii):
//   When the user ran PwrSnap alongside Splashtop (the remote-desktop
//   client, which holds its own macOS Space), triggering a capture
//   would shift the user away from their current Space. The cause was
//   that the pre-warmed selector window was a regular NSWindow —
//   show()/focus() on a regular NSWindow can drive AppKit's "find the
//   Space this window belongs to and switch to it" path, even with
//   `setVisibleOnAllWorkspaces(true)` set, because the side-effect of
//   bringing the app frontmost is part of the swap. The non-activating
//   NSPanel skips the app-activation step entirely.
//
// Fix (see createSelectorWindow in capture/region-selector.ts):
//   - `type: 'panel'` — NSPanel + NSWindowStyleMaskNonactivatingPanel
//     so show()/focus() never activates the app.
//   - `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
//     — canJoinAllSpaces so the panel isn't pinned to any single
//     Space, and visibleOnFullScreen so it covers fullscreen apps too.
//   - `setAlwaysOnTop(true, 'screen-saver')` — still required so the
//     selector clears the menu bar and any other overlays.
//
// If a future refactor drops any of these three calls, this test
// catches it.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserWindow, Display } from "electron";
import type { WindowInfo } from "../capture/window-list";

type WindowSpy = {
  setTitle: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
  setSimpleFullScreen: ReturnType<typeof vi.fn>;
  setFullScreen: ReturnType<typeof vi.fn>;
  isSimpleFullScreen: ReturnType<typeof vi.fn>;
  setContentBounds: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  getBounds: ReturnType<typeof vi.fn>;
  getContentBounds: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setFocusable: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  blur: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  moveTop: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  webContents: {
    id: number;
    on: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  options: Record<string, unknown>;
};

const constructed: WindowSpy[] = [];
const ipcListeners = new Map<string, (event: unknown, payload: unknown) => void>();
let currentIpcSender: WindowSpy["webContents"] | null = null;
const screenListeners = new Map<string, (...args: unknown[]) => void>();
const deferredLoadResolvers: (() => void)[] = [];
let deferSelectorLoads = false;
// When true, the window spy stops auto-acking `region-selector:painted`
// on a mode push — lets a test simulate a renderer that never paints
// (fail-closed timeout) or drive the ack manually (stale-URL rejection).
let suppressPaintAck = false;
let suppressPerformanceAck = false;
let suppressPresentationAck = false;
const screenSnapshotMocks = vi.hoisted(() => ({
  captureAndRegister: vi.fn(),
  releaseSnapshot: vi.fn()
}));
const windowListMocks = vi.hoisted(() => ({
  listWindowsSnapshot: vi.fn(),
  selfPidSet: vi.fn()
}));
const browserWindowFromId = vi.hoisted(() => vi.fn());

const primaryDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
  scaleFactor: 2
};
let availableDisplays = [primaryDisplay];

function selectorLoadPromise(): Promise<void> {
  if (!deferSelectorLoads) return Promise.resolve();
  return new Promise((resolve) => {
    deferredLoadResolvers.push(resolve);
  });
}

function makeWindowSpy(options: Record<string, unknown>): WindowSpy {
  let spy!: WindowSpy;
  spy = {
    setTitle: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setSimpleFullScreen: vi.fn(),
    setFullScreen: vi.fn(),
    isSimpleFullScreen: vi.fn().mockReturnValue(false),
    setContentBounds: vi.fn(),
    setBounds: vi.fn(),
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1440, height: 900 }),
    getContentBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1440, height: 900 }),
    show: vi.fn(),
    showInactive: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setFocusable: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    hide: vi.fn(),
    moveTop: vi.fn(),
    loadURL: vi.fn(() => selectorLoadPromise()),
    loadFile: vi.fn(() => selectorLoadPromise()),
    webContents: {
      id: constructed.length + 1,
      on: vi.fn(),
      // Simulate the selector renderer: when main pushes the per-show
      // mode with a snapshot URL, the real renderer loads the frozen
      // <img> and acks `region-selector:painted` — which main now gates
      // `show()` on. Mirror that ack here (next microtask, after main
      // has registered its paint waiter) so the gated show proceeds
      // without a real renderer/image decode.
      send: vi.fn((channel: string, payload: unknown) => {
        currentIpcSender = spy.webContents;
        if (channel === "region-selector:mode" && payload !== null && typeof payload === "object") {
          const modePayload = payload as {
            screenUrl?: unknown;
            invocationId?: unknown;
          };
          const url = modePayload.screenUrl;
          const invocationId = modePayload.invocationId;
          if (!suppressPaintAck && typeof url === "string" && typeof invocationId === "number") {
            queueMicrotask(() =>
              ipcListeners.get("region-selector:painted")?.(
                {},
                {
                  screenUrl: url,
                  invocationId,
                  status: "painted"
                }
              )
            );
          }
          if (!suppressPerformanceAck && typeof invocationId === "number") {
            queueMicrotask(() =>
              queueMicrotask(() =>
                ipcListeners.get("region-selector:performance")?.(
                  {},
                  {
                    invocationId,
                    mark: "shell-painted"
                  }
                )
              )
            );
          }
        }
        if (
          channel === "region-selector:presentation-arm" &&
          !suppressPresentationAck &&
          payload !== null &&
          typeof payload === "object"
        ) {
          queueMicrotask(() =>
            queueMicrotask(() =>
              ipcListeners.get("region-selector:presented")?.(
                { sender: spy.webContents },
                payload
              )
            )
          );
        }
      }),
      focus: vi.fn()
    },
    on: vi.fn(),
    once: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
    options
  };
  return spy;
}

vi.mock("electron", () => {
  class BrowserWindow {
    static fromId(id: number) {
      return browserWindowFromId(id);
    }

    constructor(options: Record<string, unknown>) {
      const spy = makeWindowSpy(options);
      constructed.push(spy);
      // Return the spy instead of `this`. Matches the pattern in
      // window-content-protection.test.ts.
      return spy as unknown as BrowserWindow;
    }
  }
  return {
    app: {
      isPackaged: false,
      getAppPath: () => "/fake/appPath"
    },
    screen: {
      getAllDisplays: () => availableDisplays,
      getDisplayNearestPoint: () => availableDisplays[0] ?? primaryDisplay,
      getDisplayMatching: () => availableDisplays[0] ?? primaryDisplay,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      screenToDipRect: (_window: unknown, rect: unknown) => rect,
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        screenListeners.set(channel, listener);
      }),
      removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        if (screenListeners.get(channel) === listener) screenListeners.delete(channel);
      })
    },
    BrowserWindow,
    globalShortcut: {
      register: vi.fn(),
      unregister: vi.fn()
    },
    ipcMain: {
      on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
        ipcListeners.set(channel, (event, payload) => {
          const hasSender = event !== null && typeof event === "object" && "sender" in event;
          listener(hasSender ? event : { sender: currentIpcSender }, payload);
        });
      }),
      removeAllListeners: vi.fn()
    }
  };
});

vi.mock("../window", () => ({
  getPreloadPath: () => "/fake/preload.cjs"
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

vi.mock("../capture/window-list", () => ({
  activateApp: vi.fn(),
  boundsApproxEqual: () => false,
  listWindows: vi.fn().mockResolvedValue([]),
  listWindowsSnapshot: windowListMocks.listWindowsSnapshot,
  selfPidSet: windowListMocks.selfPidSet
}));

vi.mock("../capture/screen-snapshot", () => ({
  captureAndRegister: screenSnapshotMocks.captureAndRegister,
  releaseSnapshot: screenSnapshotMocks.releaseSnapshot
}));

// This legacy lifecycle suite predates the renderer-owned frame transport and
// intentionally exercises the explicit file fallback. Authorization and port
// behavior have focused tests in capture/__tests__/selector-display-media.
vi.mock("../capture/selector-display-media", () => ({
  selectorDisplayMediaStrategy: () => "legacy-file",
  selectorDisplayMediaBroker: {
    install: vi.fn(),
    arm: vi.fn(() => true),
    revoke: vi.fn(() => true)
  }
}));

vi.mock("../tray", () => ({
  hideTrayPopoverIfVisible: vi.fn()
}));

vi.mock("../float-over", () => ({
  setFloatOverState: vi.fn(),
  ensureFloatOverTopmost: vi.fn()
}));

const realPlatform = process.platform;

beforeEach(() => {
  constructed.length = 0;
  ipcListeners.clear();
  currentIpcSender = null;
  screenListeners.clear();
  availableDisplays = [primaryDisplay];
  deferredLoadResolvers.length = 0;
  deferSelectorLoads = false;
  suppressPaintAck = false;
  suppressPerformanceAck = false;
  suppressPresentationAck = false;
  screenSnapshotMocks.captureAndRegister.mockReset();
  screenSnapshotMocks.releaseSnapshot.mockReset();
  windowListMocks.listWindowsSnapshot.mockReset();
  windowListMocks.selfPidSet.mockReset();
  windowListMocks.selfPidSet.mockReturnValue(new Set<number>());
  browserWindowFromId.mockReset();
  browserWindowFromId.mockReturnValue(null);
  windowListMocks.listWindowsSnapshot.mockResolvedValue({
    windows: [],
    frontmostPid: null,
    frontmostBundleId: null
  });
  screenSnapshotMocks.captureAndRegister.mockResolvedValue({
    id: "snapshot-1",
    filePath: "/tmp/snapshot.png",
    displayId: 1
  });
  vi.resetModules();
  // createSelectorWindow only sets the NSPanel (`type: 'panel'`) +
  // setVisibleOnAllWorkspaces flags this test guards on darwin — they're
  // macOS-only (Windows/Linux use a plain frameless overlay). Pin the
  // platform so the macOS Splashtop guard is actually exercised.
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: realPlatform,
    configurable: true
  });
});

describe("createSelectorWindow — Splashtop Space-shift guard (bug iii)", () => {
  test("uses type: 'panel' so show()/focus() never activates PwrSnap and pulls the user's Space", async () => {
    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();

    expect(constructed).toHaveLength(1);
    const spy = constructed[0]!;
    // The non-activating NSPanel is the load-bearing knob. Without it,
    // macOS may switch Spaces when the selector shows next to apps
    // that hold their own Space (Splashtop, Citrix, Parallels Coherence).
    expect(spy.options.type).toBe("panel");
  });

  test("calls setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) so the selector appears on the CURRENT Space, not the one it was constructed on", async () => {
    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();

    const spy = constructed[0]!;
    expect(spy.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(1);
    expect(spy.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true
    });
  });

  test("calls setAlwaysOnTop(true, 'screen-saver') so the selector clears the menu bar and other overlays", async () => {
    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();

    const spy = constructed[0]!;
    expect(spy.setAlwaysOnTop).toHaveBeenCalledTimes(1);
    expect(spy.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
  });

  test("disables background throttling so hidden prewarm loads before the first shortcut", async () => {
    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();

    const spy = constructed[0]!;
    expect(spy.options.webPreferences).toMatchObject({
      backgroundThrottling: false
    });
  });

  test("also disables background throttling for the hidden Windows prewarm", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();

    expect(constructed[0]?.options.webPreferences).toMatchObject({
      backgroundThrottling: false
    });
  });

  test("setVisibleOnAllWorkspaces is called BEFORE the renderer loads — first paint must not flash on the wrong Space", async () => {
    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();

    const spy = constructed[0]!;
    const workspacesOrder = spy.setVisibleOnAllWorkspaces.mock.invocationCallOrder[0];
    const fileOrder = spy.loadFile.mock.invocationCallOrder[0];
    const urlOrder = spy.loadURL.mock.invocationCallOrder[0];
    const loadOrder = fileOrder ?? urlOrder;
    expect(workspacesOrder).toBeDefined();
    if (loadOrder !== undefined && workspacesOrder !== undefined) {
      expect(workspacesOrder).toBeLessThan(loadOrder);
    }
  });

  test("re-raises the visible selector with moveTop after show/focus without activating the app", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const onSelectorPresented = vi.fn();
    const pick = pickRegion({ onSelectorPresented });

    await vi.waitFor(() => {
      expect(constructed[0]?.moveTop).toHaveBeenCalledTimes(1);
      expect(onSelectorPresented).toHaveBeenCalledWith({
        invocationId: 1,
        surface: "frozen-frame"
      });
    });

    const spy = constructed[0]!;
    const showOrder = spy.show.mock.invocationCallOrder[0];
    const focusOrder = spy.focus.mock.invocationCallOrder[0];
    const webFocusOrder = spy.webContents.focus.mock.invocationCallOrder[0];
    const moveTopOrder = spy.moveTop.mock.invocationCallOrder[0];
    const armCallIndex = spy.webContents.send.mock.calls.findIndex(
      ([channel]) => channel === "region-selector:presentation-arm"
    );
    const armOrder = spy.webContents.send.mock.invocationCallOrder[armCallIndex];

    expect(showOrder).toBeDefined();
    expect(focusOrder).toBeDefined();
    expect(webFocusOrder).toBeDefined();
    expect(moveTopOrder).toBeDefined();
    expect(armOrder).toBeDefined();
    expect(moveTopOrder!).toBeGreaterThan(showOrder!);
    expect(moveTopOrder!).toBeGreaterThan(focusOrder!);
    expect(moveTopOrder!).toBeGreaterThan(webFocusOrder!);
    expect(armOrder!).toBeGreaterThan(moveTopOrder!);

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
  });

  test("swaps in a warmed macOS standby selector after hide so the next capture starts fresh", async () => {
    const { hideSelector, pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ keepPwrSnapChrome: true });

    expect(constructed).toHaveLength(1);
    const first = constructed[0]!;

    await vi.waitFor(() => {
      expect(first.show).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(constructed).toHaveLength(2);
    });
    const standby = constructed[1]!;

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });

    hideSelector();

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(standby.destroy).not.toHaveBeenCalled();
    expect(constructed).toHaveLength(2);
    expect(standby.options.type).toBe("panel");
    expect(standby.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(standby.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true
    });

    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();
    expect(constructed).toHaveLength(2);
  });

  test("does not warm a standby selector until after the current screen snapshot completes", async () => {
    let resolveSnapshot!: (value: { id: string; filePath: string; displayId: number }) => void;
    screenSnapshotMocks.captureAndRegister.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      })
    );

    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.show).not.toHaveBeenCalled();

    resolveSnapshot({
      id: "snapshot-1",
      filePath: "/tmp/snapshot.png",
      displayId: 1
    });

    await vi.waitFor(() => {
      expect(constructed[0]?.show).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(constructed).toHaveLength(2);
    });

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
  });

  test("uses the swapped standby selector on the next capture", async () => {
    const { hideSelector, pickRegion } = await import("../capture/region-selector");
    const firstPick = pickRegion({ keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(constructed[0]?.show).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(constructed).toHaveLength(2);
    });
    const standby = constructed[1]!;

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
    await expect(firstPick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
    hideSelector();

    const secondPick = pickRegion({ mode: "window", keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(standby.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({
          mode: "window",
          invocationId: 2
        })
      );
      expect(standby.show).toHaveBeenCalledTimes(1);
    });
    if (constructed[2] !== undefined) {
      expect(constructed[2].show).not.toHaveBeenCalled();
    }

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 2 });
    await expect(secondPick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
  });

  test("waits for a swapped standby selector renderer to load before sending per-show mode", async () => {
    const { hideSelector, pickRegion, preWarmRegionSelector } = await import(
      "../capture/region-selector"
    );
    preWarmRegionSelector();
    deferSelectorLoads = true;
    const firstPick = pickRegion({ keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(constructed[0]?.show).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect(constructed).toHaveLength(2);
    });
    expect(deferredLoadResolvers).toHaveLength(1);
    const standby = constructed[1]!;

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
    await expect(firstPick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
    hideSelector();

    const pick = pickRegion({ mode: "window", keepPwrSnapChrome: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(standby.webContents.send).not.toHaveBeenCalledWith(
      "region-selector:mode",
      expect.anything()
    );
    expect(standby.show).not.toHaveBeenCalled();

    deferredLoadResolvers.shift()?.();

    await vi.waitFor(() => {
      expect(standby.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({
          mode: "window",
          invocationId: 2
        })
      );
      expect(standby.show).toHaveBeenCalledTimes(1);
    });

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 2 });
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
  });
});

describe("region-selector — Windows shell-first latency contract", () => {
  test("paints and shows loading feedback before starting native window enumeration", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    suppressPresentationAck = true;
    const { setFloatOverState } = await import("../float-over");
    vi.mocked(setFloatOverState).mockClear();
    let resolveWindowList!: (value: {
      windows: WindowInfo[];
      frontmostPid: number | null;
      frontmostBundleId: string | null;
    }) => void;
    windowListMocks.listWindowsSnapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveWindowList = resolve;
      })
    );

    const { pickRegion } = await import("../capture/region-selector");
    const onSelectorPresented = vi.fn(() => {
      throw new Error("HUD callback failed");
    });
    const pick = pickRegion({
      mode: "window",
      keepPwrSnapChrome: true,
      onSelectorPresented
    });

    await vi.waitFor(() => expect(constructed[0]?.showInactive).toHaveBeenCalledTimes(1));
    expect(windowListMocks.listWindowsSnapshot).not.toHaveBeenCalled();
    expect(onSelectorPresented).not.toHaveBeenCalled();

    const armCallIndex = constructed[0]?.webContents.send.mock.calls.findIndex(
      ([channel]) => channel === "region-selector:presentation-arm"
    );
    expect(armCallIndex).toBeGreaterThanOrEqual(0);
    const armPayload = constructed[0]?.webContents.send.mock.calls[armCallIndex!]?.[1];
    expect(armPayload).toEqual({
      invocationId: 1,
      generation: expect.any(Number),
      surface: "window-loading"
    });

    // The hidden diagnostic paint mark is not a presentation acknowledgement.
    ipcListeners.get("region-selector:performance")?.(
      {},
      { invocationId: 1, mark: "shell-painted" }
    );
    await Promise.resolve();
    expect(windowListMocks.listWindowsSnapshot).not.toHaveBeenCalled();
    expect(onSelectorPresented).not.toHaveBeenCalled();

    ipcListeners.get("region-selector:presented")?.(
      { sender: { id: 999_999 } },
      armPayload
    );
    await Promise.resolve();
    expect(windowListMocks.listWindowsSnapshot).not.toHaveBeenCalled();

    ipcListeners.get("region-selector:presented")?.(
      {},
      { ...(armPayload as object), generation: -1 }
    );
    await Promise.resolve();
    expect(windowListMocks.listWindowsSnapshot).not.toHaveBeenCalled();

    ipcListeners.get("region-selector:presented")?.({}, armPayload);
    await vi.waitFor(() => {
      expect(windowListMocks.listWindowsSnapshot).toHaveBeenCalledTimes(1);
    });
    expect(onSelectorPresented).toHaveBeenCalledTimes(1);
    expect(onSelectorPresented).toHaveBeenCalledWith({
      invocationId: 1,
      surface: "window-loading"
    });
    ipcListeners.get("region-selector:presented")?.({}, armPayload);
    expect(onSelectorPresented).toHaveBeenCalledTimes(1);
    expect(windowListMocks.listWindowsSnapshot).toHaveBeenCalledTimes(1);

    const modeSend = constructed[0]?.webContents.send.mock.calls.find(
      ([channel]) => channel === "region-selector:mode"
    );
    expect(modeSend?.[1]).toEqual(expect.objectContaining({ mode: "window", invocationId: 1 }));
    expect(modeSend?.[1]).not.toHaveProperty("screenUrl");
    expect(screenSnapshotMocks.captureAndRegister).not.toHaveBeenCalled();

    const showOrder = constructed[0]?.showInactive.mock.invocationCallOrder[0];
    const armOrder = constructed[0]?.webContents.send.mock.invocationCallOrder[armCallIndex!];
    const enumerateOrder = windowListMocks.listWindowsSnapshot.mock.invocationCallOrder[0];
    expect(showOrder).toBeDefined();
    expect(armOrder).toBeDefined();
    expect(enumerateOrder).toBeDefined();
    const focusableOffIndex = constructed[0]?.setFocusable.mock.calls.findIndex(
      ([focusable]) => focusable === false
    );
    expect(focusableOffIndex).toBeGreaterThanOrEqual(0);
    expect(constructed[0]?.setFocusable.mock.invocationCallOrder[focusableOffIndex!]).toBeLessThan(
      showOrder!
    );
    expect(showOrder!).toBeLessThan(armOrder!);
    expect(armOrder!).toBeLessThan(enumerateOrder!);
    expect(constructed[0]?.setIgnoreMouseEvents).not.toHaveBeenCalled();
    expect(constructed[0]?.focus).not.toHaveBeenCalled();
    expect(setFloatOverState).toHaveBeenCalledWith({ kind: "cancel" });
    expect(setFloatOverState).not.toHaveBeenCalledWith({ kind: "show-idle" });

    resolveWindowList({
      windows: [],
      frontmostPid: null,
      frontmostBundleId: null
    });
    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:window-list",
        expect.objectContaining({
          invocationId: 1,
          status: "ready",
          windows: []
        })
      );
      expect(constructed[0]?.setFocusable).toHaveBeenCalledWith(true);
      expect(constructed[0]?.focus).toHaveBeenCalledTimes(1);
    });
    const focusableOnIndex = constructed[0]?.setFocusable.mock.calls.findIndex(
      ([focusable]) => focusable === true
    );
    expect(enumerateOrder!).toBeLessThan(
      constructed[0]?.setFocusable.mock.invocationCallOrder[focusableOnIndex!]!
    );
    expect(constructed[0]?.setFocusable.mock.invocationCallOrder[focusableOnIndex!]!).toBeLessThan(
      constructed[0]?.focus.mock.invocationCallOrder[0]!
    );
    expect(setFloatOverState).not.toHaveBeenCalledWith({ kind: "show-idle" });

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
  });

  test("uses a bounded snapshot and excludes the protected Library by HWND despite mismatched DWM bounds", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    const { setFloatOverState } = await import("../float-over");
    vi.mocked(setFloatOverState).mockClear();
    const protectedLibrary = {
      isDestroyed: vi.fn().mockReturnValue(false),
      setContentProtection: vi.fn(),
      getNativeWindowHandle: vi.fn().mockReturnValue(Buffer.from([10, 0, 0, 0, 0, 0, 0, 0])),
      getBounds: vi.fn().mockReturnValue({ x: 240, y: 30, width: 1000, height: 700 })
    };
    browserWindowFromId.mockImplementation((id: number) => (id === 91 ? protectedLibrary : null));
    windowListMocks.selfPidSet.mockReturnValue(new Set([4242]));
    windowListMocks.listWindowsSnapshot.mockResolvedValueOnce({
      windows: [
        {
          windowId: 10,
          pid: 4242,
          bundleId: "C:\\PwrSnap.exe",
          appName: "PwrSnap",
          title: "PwrSnap Library",
          // Deliberately differs from BrowserWindow.getBounds(): DWM reports
          // extended-frame bounds, so HWND — not approximate bounds — must
          // drive protected-window exclusion on Windows.
          bounds: { x: 230, y: 20, width: 1020, height: 720 },
          layer: 0,
          alpha: 1,
          isFrontmostInApp: true
        },
        {
          windowId: 20,
          pid: 5555,
          bundleId: "C:\\Claude.exe",
          appName: "Claude",
          title: "Claude",
          bounds: { x: 100, y: 50, width: 1200, height: 800 },
          layer: 0,
          alpha: 1,
          isFrontmostInApp: true
        }
      ],
      frontmostPid: 4242,
      frontmostBundleId: "C:\\PwrSnap.exe"
    });

    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({
      mode: "window",
      keepPwrSnapChrome: true,
      protectWindowIds: [91]
    });

    await vi.waitFor(() => {
      expect(constructed[0]?.showInactive).toHaveBeenCalledTimes(1);
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:window-list",
        expect.objectContaining({
          invocationId: 1,
          status: "ready",
          windows: [expect.objectContaining({ windowId: 20 })]
        })
      );
    });

    // Pure window mode commits only an allowlisted HWND and never acquires a
    // display frame, even when the trigger window must be excluded.
    expect(screenSnapshotMocks.captureAndRegister).not.toHaveBeenCalled();
    expect(protectedLibrary.setContentProtection).not.toHaveBeenCalled();
    expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
      "region-selector:mode",
      expect.objectContaining({
        mode: "window",
        captureSource: { kind: "none" }
      })
    );
    expect(setFloatOverState).not.toHaveBeenCalledWith({ kind: "show-idle" });
    expect(windowListMocks.listWindowsSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      constructed[0]?.focus.mock.invocationCallOrder[0]!
    );

    ipcListeners.get("region-selector:result")?.(
      {},
      {
        ok: true,
        invocationId: 1,
        rect: { x: 230, y: 20, w: 1020, h: 720 },
        displayId: 1,
        snappedWindowId: 10,
        fullWindow: true
      }
    );
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled",
      previousAppOrigin: "pwrsnap",
      previousAppPid: null
    });
  });

  test("rejects a spoofed protected HWND on an auto-mode non-full-window result", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    const protectedLibrary = {
      isDestroyed: vi.fn().mockReturnValue(false),
      setContentProtection: vi.fn(),
      getNativeWindowHandle: vi.fn().mockReturnValue(Buffer.from([10, 0, 0, 0, 0, 0, 0, 0])),
      getBounds: vi.fn().mockReturnValue({ x: 240, y: 30, width: 1000, height: 700 })
    };
    browserWindowFromId.mockImplementation((id: number) => (id === 91 ? protectedLibrary : null));
    windowListMocks.selfPidSet.mockReturnValue(new Set([4242]));
    windowListMocks.listWindowsSnapshot.mockResolvedValueOnce({
      windows: [
        {
          windowId: 10,
          pid: 4242,
          bundleId: "C:\\PwrSnap.exe",
          appName: "PwrSnap",
          title: "PwrSnap Library",
          bounds: { x: 230, y: 20, width: 1020, height: 720 },
          layer: 0,
          alpha: 1,
          isFrontmostInApp: true
        },
        {
          windowId: 20,
          pid: 5555,
          bundleId: "C:\\Claude.exe",
          appName: "Claude",
          title: "Claude",
          bounds: { x: 100, y: 50, width: 1200, height: 800 },
          layer: 0,
          alpha: 1,
          isFrontmostInApp: true
        }
      ],
      frontmostPid: 4242,
      frontmostBundleId: "C:\\PwrSnap.exe"
    });

    const { hideSelector, pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({
      mode: "auto",
      keepPwrSnapChrome: true,
      protectWindowIds: [91]
    });
    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:window-list",
        expect.objectContaining({
          status: "ready",
          windows: [expect.objectContaining({ windowId: 20 })]
        })
      );
    });

    ipcListeners.get("region-selector:result")?.(
      {},
      {
        ok: true,
        invocationId: 1,
        rect: { x: 230, y: 20, w: 1020, h: 720 },
        displayId: 1,
        snappedWindowId: 10,
        fullWindow: false
      }
    );
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
    hideSelector();
  });

  test("keeps float-over hidden and preserves committed geometry after validating the candidate", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    const { setFloatOverState } = await import("../float-over");
    vi.mocked(setFloatOverState).mockClear();
    windowListMocks.selfPidSet.mockReturnValue(new Set([4242]));
    windowListMocks.listWindowsSnapshot.mockImplementationOnce(async () => {
      expect(setFloatOverState).toHaveBeenCalledWith({ kind: "cancel" });
      expect(setFloatOverState).not.toHaveBeenCalledWith({ kind: "show-idle" });
      return {
        windows: [
          {
            windowId: 20,
            pid: 5555,
            bundleId: "C:\\Claude.exe",
            appName: "Claude",
            title: "Claude",
            bounds: { x: 100, y: 50, width: 1200, height: 800 },
            layer: 0,
            alpha: 1,
            isFrontmostInApp: true
          }
        ],
        frontmostPid: 5555,
        frontmostBundleId: "C:\\Claude.exe"
      };
    });

    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "window", keepPwrSnapChrome: true });
    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:window-list",
        expect.objectContaining({
          invocationId: 1,
          status: "ready",
          windows: [expect.objectContaining({ windowId: 20, ownedByUs: false })]
        })
      );
      expect(constructed[0]?.focus).toHaveBeenCalledTimes(1);
    });
    expect(setFloatOverState).not.toHaveBeenCalledWith({ kind: "show-idle" });

    ipcListeners.get("region-selector:result")?.(
      {},
      {
        ok: true,
        invocationId: 1,
        // This may be raw full-window or user-adjusted geometry. The id is
        // authenticated against the candidate list without replacing it.
        rect: { x: 120, y: 60, w: 1100, h: 700 },
        displayId: 1,
        snappedWindowId: 20,
        fullWindow: true
      }
    );
    await expect(pick).resolves.toMatchObject({
      ok: true,
      rect: { x: 120, y: 60, w: 1100, h: 700 },
      snappedWindowId: 20,
      fullWindow: true,
      previousAppOrigin: "external",
      previousAppPid: 5555
    });
  });

  test("starts pure-window enumeration only from the post-show presentation ack", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    suppressPaintAck = true;
    suppressPerformanceAck = true;
    suppressPresentationAck = true;
    vi.useFakeTimers();
    try {
      const { pickRegion } = await import("../capture/region-selector");
      const pick = pickRegion({
        mode: "window",
        keepPwrSnapChrome: true,
        protectWindowIds: [999]
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({
          invocationId: 1,
          captureSource: { kind: "none" }
        })
      );
      expect(constructed[0]?.showInactive).toHaveBeenCalledTimes(1);
      expect(screenSnapshotMocks.captureAndRegister).not.toHaveBeenCalled();
      const armPayload = constructed[0]?.webContents.send.mock.calls.find(
        ([channel]) => channel === "region-selector:presentation-arm"
      )?.[1];
      expect(armPayload).toEqual(
        expect.objectContaining({ invocationId: 1, surface: "window-loading" })
      );
      ipcListeners.get("region-selector:performance")?.(
        {},
        {
          invocationId: 1,
          mark: "shell-painted"
        }
      );
      expect(windowListMocks.listWindowsSnapshot).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(0);
      expect(windowListMocks.listWindowsSnapshot).not.toHaveBeenCalled();

      ipcListeners.get("region-selector:presented")?.({}, armPayload);
      await vi.advanceTimersByTimeAsync(0);
      expect(windowListMocks.listWindowsSnapshot).toHaveBeenCalledTimes(1);

      ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
      await expect(pick).resolves.toMatchObject({
        ok: false,
        reason: "cancelled"
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("terminates instead of lying when post-show presentation is never acknowledged", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    suppressPresentationAck = true;
    vi.useFakeTimers();
    try {
      const { pickRegion } = await import("../capture/region-selector");
      const onSelectorPresented = vi.fn();
      const pick = pickRegion({
        mode: "window",
        keepPwrSnapChrome: true,
        onSelectorPresented
      });
      let settled = false;
      void pick.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(constructed[0]?.showInactive).toHaveBeenCalledTimes(1);
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:presentation-arm",
        expect.objectContaining({ invocationId: 1, surface: "window-loading" })
      );
      expect(windowListMocks.listWindowsSnapshot).not.toHaveBeenCalled();
      expect(onSelectorPresented).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pick).resolves.toMatchObject({ ok: false, reason: "destroyed" });
      expect(onSelectorPresented).not.toHaveBeenCalled();
      expect(windowListMocks.listWindowsSnapshot).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("ignores id-less and wrong-sender results until the matching selector sends", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "window", keepPwrSnapChrome: true });
    let settled = false;
    void pick.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(constructed[0]?.showInactive).toHaveBeenCalledTimes(1));
    ipcListeners.get("region-selector:result")?.({}, { ok: false });
    ipcListeners.get("region-selector:result")?.(
      { sender: { id: 999_999 } },
      { ok: false, invocationId: 1 }
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
  });

  test("rejects a window result before candidate enumeration is ready", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    let resolveWindowList!: (value: {
      windows: WindowInfo[];
      frontmostPid: number | null;
      frontmostBundleId: string | null;
    }) => void;
    windowListMocks.listWindowsSnapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveWindowList = resolve;
      })
    );
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "window", keepPwrSnapChrome: true });
    await vi.waitFor(() => {
      expect(windowListMocks.listWindowsSnapshot).toHaveBeenCalledTimes(1);
    });

    ipcListeners.get("region-selector:result")?.(
      {},
      {
        ok: true,
        invocationId: 1,
        rect: { x: 100, y: 50, w: 1200, h: 800 },
        displayId: 1,
        snappedWindowId: 20,
        fullWindow: true
      }
    );
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
    resolveWindowList({
      windows: [],
      frontmostPid: null,
      frontmostBundleId: null
    });
  });

  test("rejects an HWND absent from the filtered invocation candidates", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    windowListMocks.listWindowsSnapshot.mockResolvedValueOnce({
      windows: [
        {
          windowId: 20,
          pid: 5555,
          bundleId: "C:\\Claude.exe",
          appName: "Claude",
          title: "Claude",
          bounds: { x: 100, y: 50, width: 1200, height: 800 },
          layer: 0,
          alpha: 1,
          isFrontmostInApp: true
        }
      ],
      frontmostPid: 5555,
      frontmostBundleId: "C:\\Claude.exe"
    });
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "window", keepPwrSnapChrome: true });
    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:window-list",
        expect.objectContaining({ status: "ready" })
      );
    });

    ipcListeners.get("region-selector:result")?.(
      {},
      {
        ok: true,
        invocationId: 1,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        displayId: 1,
        snappedWindowId: 999_999,
        fullWindow: true
      }
    );
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
  });

  test("rejects an allowed HWND when the renderer reports a different display", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    windowListMocks.listWindowsSnapshot.mockResolvedValueOnce({
      windows: [
        {
          windowId: 20,
          pid: 5555,
          bundleId: "C:\\Claude.exe",
          appName: "Claude",
          title: "Claude",
          bounds: { x: 100, y: 50, width: 1200, height: 800 },
          layer: 0,
          alpha: 1,
          isFrontmostInApp: true
        }
      ],
      frontmostPid: 5555,
      frontmostBundleId: "C:\\Claude.exe"
    });
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "window", keepPwrSnapChrome: true });
    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:window-list",
        expect.objectContaining({ status: "ready" })
      );
    });

    ipcListeners.get("region-selector:result")?.(
      {},
      {
        ok: true,
        invocationId: 1,
        rect: { x: 100, y: 50, w: 1200, h: 800 },
        displayId: 2,
        snappedWindowId: 20,
        fullWindow: true
      }
    );
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
  });

  test("cancel during deferred enumeration reports an unknown previous-app origin", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    let resolveWindowList!: (value: {
      windows: WindowInfo[];
      frontmostPid: number | null;
      frontmostBundleId: string | null;
    }) => void;
    windowListMocks.listWindowsSnapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveWindowList = resolve;
      })
    );

    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "window", keepPwrSnapChrome: true });
    await vi.waitFor(() => {
      expect(constructed[0]?.showInactive).toHaveBeenCalledTimes(1);
      expect(windowListMocks.listWindowsSnapshot).toHaveBeenCalledTimes(1);
    });

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
    await expect(pick).resolves.toEqual({
      ok: false,
      reason: "cancelled",
      previousAppOrigin: "unknown",
      previousAppPid: null
    });
    expect(constructed[0]?.setFocusable.mock.calls).toEqual([[false], [true]]);
    expect(constructed[0]?.setIgnoreMouseEvents).not.toHaveBeenCalled();

    resolveWindowList({
      windows: [],
      frontmostPid: null,
      frontmostBundleId: null
    });
  });

  test("suppresses a duplicate picker without replacing or hiding the active invocation", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    const { pickRegion } = await import("../capture/region-selector");
    const first = pickRegion({ mode: "window", keepPwrSnapChrome: true });
    const busyPresented = vi.fn();

    await vi.waitFor(() => expect(constructed[0]?.showInactive).toHaveBeenCalledTimes(1));
    await expect(
      pickRegion({
        mode: "window",
        keepPwrSnapChrome: true,
        onSelectorPresented: busyPresented
      })
    ).resolves.toEqual({
      ok: false,
      reason: "busy",
      previousAppOrigin: "unknown",
      previousAppPid: null
    });

    expect(busyPresented).not.toHaveBeenCalled();
    expect(constructed[0]?.hide).not.toHaveBeenCalled();
    expect(screenSnapshotMocks.captureAndRegister).not.toHaveBeenCalled();
    expect(windowListMocks.listWindowsSnapshot).toHaveBeenCalledTimes(1);

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
    await expect(first).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
  });
});

describe("region-selector — snapshot-paint gate before show()", () => {
  test("reveals a safe error shell and remains cancellable when snapshot decode fails", async () => {
    suppressPaintAck = true;
    const { pickRegion } = await import("../capture/region-selector");
    const onSelectorPresented = vi.fn();
    const pick = pickRegion({
      mode: "region",
      keepPwrSnapChrome: true,
      onSelectorPresented
    });
    let settled = false;
    void pick.then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({
          invocationId: 1,
          screenUrl: "pwrsnap-screen://r/snapshot-1"
        })
      );
    });
    ipcListeners.get("region-selector:painted")?.(
      {},
      {
        screenUrl: "pwrsnap-screen://r/snapshot-1",
        invocationId: 1,
        status: "error"
      }
    );

    await vi.waitFor(() => {
      expect(constructed[0]?.show).toHaveBeenCalledTimes(1);
      expect(onSelectorPresented).toHaveBeenCalledWith({
        invocationId: 1,
        surface: "error"
      });
    });
    expect(settled).toBe(false);

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
    await expect(pick).resolves.toEqual({
      ok: false,
      reason: "cancelled",
      previousAppOrigin: "unknown",
      previousAppPid: null
    });
  });

  test("terminates without presenting when the renderer never acks hidden paint", async () => {
    // Simulate a wedged renderer: the mode/snapshot is pushed (so it
    // COULD paint) but the `region-selector:painted` ack never fires.
    suppressPaintAck = true;
    vi.useFakeTimers();
    try {
      const { pickRegion } = await import("../capture/region-selector");
      const pick = pickRegion();

      // Advance the existing compositor-flush timer; this is test setup, not
      // a picker presentation delay.
      await vi.advanceTimersByTimeAsync(50);
      for (let i = 0; i < 10 && constructed[0]?.webContents.send.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({ screenUrl: "pwrsnap-screen://r/snapshot-1" })
      );

      // A timeout cannot truthfully claim that frozen pixels were presented.
      // Fail closed so the caller's finally block clears its handoff HUD.
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(pick).resolves.toMatchObject({
        ok: false,
        reason: "destroyed"
      });
      expect(constructed[0]?.show).not.toHaveBeenCalled();
      expect(constructed[0]?.webContents.send).not.toHaveBeenCalledWith(
        "region-selector:presentation-arm",
        expect.anything()
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("ignores a painted ack with a stale screenUrl, then reveals on the matching one", async () => {
    suppressPaintAck = true;
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion();

    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({ screenUrl: "pwrsnap-screen://r/snapshot-1" })
      );
    });

    // Even a matching token/URL cannot paint or force the error shell from a
    // different renderer.
    ipcListeners.get("region-selector:painted")?.(
      { sender: { id: 999_999 } },
      {
        screenUrl: "pwrsnap-screen://r/snapshot-1",
        invocationId: 1,
        status: "error"
      }
    );
    await Promise.resolve();
    expect(constructed[0]?.show).not.toHaveBeenCalled();

    // A late ack from a SUPERSEDED capture (different screenUrl) must not
    // satisfy the current wait — the selector stays hidden. (Well under
    // the 250ms timeout, so the fallback can't be what keeps it hidden.)
    ipcListeners.get("region-selector:painted")?.(
      {},
      {
        screenUrl: "pwrsnap-screen://r/stale-0",
        invocationId: 1,
        status: "painted"
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(constructed[0]?.show).not.toHaveBeenCalled();

    // The ack for the CURRENT snapshot reveals it.
    ipcListeners.get("region-selector:painted")?.(
      {},
      {
        screenUrl: "pwrsnap-screen://r/snapshot-1",
        invocationId: 1,
        status: "painted"
      }
    );
    await vi.waitFor(() => {
      expect(constructed[0]?.show).toHaveBeenCalledTimes(1);
    });

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
  });
});

describe("region-selector — active lifecycle teardown", () => {
  test("teardown drops a pending presentation callback and rejects its late ack", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    suppressPresentationAck = true;
    const { pickRegion } = await import("../capture/region-selector");
    const onSelectorPresented = vi.fn();
    const pick = pickRegion({
      mode: "window",
      keepPwrSnapChrome: true,
      onSelectorPresented
    });

    await vi.waitFor(() => expect(constructed[0]?.showInactive).toHaveBeenCalledTimes(1));
    const armPayload = constructed[0]?.webContents.send.mock.calls.find(
      ([channel]) => channel === "region-selector:presentation-arm"
    )?.[1];
    const closed = constructed[0]?.once.mock.calls.find(
      ([channel]) => channel === "closed"
    )?.[1] as (() => void) | undefined;
    if (closed === undefined) throw new Error("missing selector closed listener");

    closed();
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "destroyed" });
    ipcListeners.get("region-selector:presented")?.(
      { sender: constructed[0]?.webContents },
      armPayload
    );
    expect(onSelectorPresented).not.toHaveBeenCalled();
    expect(windowListMocks.listWindowsSnapshot).not.toHaveBeenCalled();
  });

  test("close settles during a deferred capture and releases the late snapshot once", async () => {
    let resolveCapture!: (value: { id: string; filePath: string; displayId: number }) => void;
    screenSnapshotMocks.captureAndRegister.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCapture = resolve;
      })
    );
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "region", keepPwrSnapChrome: true });
    await vi.waitFor(() => {
      expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledTimes(1);
    });
    expect(constructed[0]?.webContents.send).not.toHaveBeenCalledWith(
      "region-selector:mode",
      expect.anything()
    );
    const closed = constructed[0]?.once.mock.calls.find(
      ([channel]) => channel === "closed"
    )?.[1] as (() => void) | undefined;
    if (closed === undefined) throw new Error("missing selector closed listener");

    closed();
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "destroyed"
    });
    expect(screenSnapshotMocks.releaseSnapshot).not.toHaveBeenCalled();

    resolveCapture({
      id: "late-snapshot",
      filePath: "/tmp/late.png",
      displayId: 1
    });
    await vi.waitFor(() => {
      expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledWith("late-snapshot");
    });
    closed();
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledTimes(1);
  });

  test("display removal also settles during deferred capture and releases late pixels once", async () => {
    let resolveCapture!: (value: { id: string; filePath: string; displayId: number }) => void;
    screenSnapshotMocks.captureAndRegister.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCapture = resolve;
      })
    );
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "region", keepPwrSnapChrome: true });
    await vi.waitFor(() => {
      expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledTimes(1);
    });
    const displayRemoved = screenListeners.get("display-removed");
    if (displayRemoved === undefined) throw new Error("missing display-removed listener");
    availableDisplays = [];

    displayRemoved({}, primaryDisplay);
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "destroyed"
    });
    resolveCapture({
      id: "late-display-snapshot",
      filePath: "/tmp/late.png",
      displayId: 1
    });
    await vi.waitFor(() => {
      expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledWith("late-display-snapshot");
    });
    displayRemoved({}, primaryDisplay);
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledTimes(1);
  });

  test("window close supersedes a pending paint and releases its snapshot exactly once", async () => {
    suppressPaintAck = true;
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "region", keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({ invocationId: 1 })
      );
    });
    const closed = constructed[0]?.once.mock.calls.find(
      ([channel]) => channel === "closed"
    )?.[1] as (() => void) | undefined;
    if (closed === undefined) throw new Error("missing selector closed listener");

    closed();
    closed();

    await expect(pick).resolves.toEqual({
      ok: false,
      reason: "destroyed",
      previousAppOrigin: "unknown",
      previousAppPid: null
    });
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledWith("snapshot-1");

    ipcListeners.get("region-selector:painted")?.(
      {},
      {
        screenUrl: "pwrsnap-screen://r/snapshot-1",
        invocationId: 1,
        status: "painted"
      }
    );
    await Promise.resolve();
    expect(constructed[0]?.show).not.toHaveBeenCalled();
  });

  test("render-process-gone and the following close share one idempotent teardown", async () => {
    suppressPaintAck = true;
    const { globalShortcut } = await import("electron");
    vi.mocked(globalShortcut.unregister).mockClear();
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "region", keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({ invocationId: 1 })
      );
    });
    const renderProcessGone = constructed[0]?.webContents.on.mock.calls.find(
      ([channel]) => channel === "render-process-gone"
    )?.[1] as ((event: unknown, details: { reason: string }) => void) | undefined;
    const closed = constructed[0]?.once.mock.calls.find(
      ([channel]) => channel === "closed"
    )?.[1] as (() => void) | undefined;
    if (renderProcessGone === undefined || closed === undefined) {
      throw new Error("missing selector lifecycle listener");
    }

    renderProcessGone({}, { reason: "crashed" });
    closed();

    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "destroyed"
    });
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(globalShortcut.unregister).toHaveBeenCalledTimes(2);
    expect(globalShortcut.unregister).toHaveBeenCalledWith("Escape");
    expect(globalShortcut.unregister).toHaveBeenCalledWith("Return");
  });

  test("display removal settles the active selector once and releases its snapshot once", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "region", keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(constructed[0]?.show).toHaveBeenCalledTimes(1);
    });
    const displayRemoved = screenListeners.get("display-removed");
    if (displayRemoved === undefined) throw new Error("missing display-removed listener");
    availableDisplays = [];

    displayRemoved({}, primaryDisplay);
    displayRemoved({}, primaryDisplay);

    await expect(pick).resolves.toEqual({
      ok: false,
      reason: "destroyed",
      previousAppOrigin: "unknown",
      previousAppPid: null
    });
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledWith("snapshot-1");
  });

  test("target geometry changes terminate the invocation while work-area-only changes do not", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "region", keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(constructed[0]?.show).toHaveBeenCalledTimes(1);
    });
    const displayMetricsChanged = screenListeners.get("display-metrics-changed");
    if (displayMetricsChanged === undefined) {
      throw new Error("missing display-metrics-changed listener");
    }
    let settled = false;
    void pick.then(() => {
      settled = true;
    });

    displayMetricsChanged({}, primaryDisplay, ["workArea"]);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(screenSnapshotMocks.releaseSnapshot).not.toHaveBeenCalled();

    const resizedDisplay = {
      ...primaryDisplay,
      bounds: { x: 100, y: 0, width: 1920, height: 1080 }
    };
    displayMetricsChanged({}, resizedDisplay, ["bounds"]);

    await expect(pick).resolves.toEqual({
      ok: false,
      reason: "destroyed",
      previousAppOrigin: "unknown",
      previousAppPid: null
    });
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledWith("snapshot-1");
  });

  test("dispose tears down an active selector and removes every IPC and display listener", async () => {
    suppressPaintAck = true;
    const { ipcMain, screen } = await import("electron");
    const { disposeRegionSelector, pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "region", keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({ invocationId: 1 })
      );
    });
    disposeRegionSelector();

    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "destroyed"
    });
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(ipcMain.removeAllListeners).toHaveBeenCalledWith("region-selector:result");
    expect(ipcMain.removeAllListeners).toHaveBeenCalledWith("region-selector:painted");
    expect(ipcMain.removeAllListeners).toHaveBeenCalledWith("region-selector:diagnostics");
    expect(ipcMain.removeAllListeners).toHaveBeenCalledWith("region-selector:performance");
    expect(ipcMain.removeAllListeners).toHaveBeenCalledWith("region-selector:presented");
    expect(screen.removeListener).toHaveBeenCalledWith(
      "display-metrics-changed",
      expect.any(Function)
    );
    expect(screen.removeListener).toHaveBeenCalledWith("display-added", expect.any(Function));
    expect(screen.removeListener).toHaveBeenCalledWith("display-removed", expect.any(Function));
  });
});

describe("windowsNativeWindowId", () => {
  test("decodes 32-bit and 64-bit HWND buffers as little-endian", async () => {
    const { windowsNativeWindowId } = await import("../capture/region-selector");
    expect(windowsNativeWindowId(Buffer.from([0x34, 0x12, 0, 0]))).toBe(0x1234);

    const handle64 = Buffer.alloc(8);
    handle64.writeBigUInt64LE(0x1234_5678n);
    expect(windowsNativeWindowId(handle64)).toBe(0x1234_5678);
  });

  test("rejects invalid pointer sizes, zero handles, and unsafe integers", async () => {
    const { windowsNativeWindowId } = await import("../capture/region-selector");
    expect(windowsNativeWindowId(Buffer.alloc(3))).toBeNull();
    expect(windowsNativeWindowId(Buffer.alloc(8))).toBeNull();

    const unsafe = Buffer.alloc(8);
    unsafe.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(windowsNativeWindowId(unsafe)).toBeNull();
  });
});

describe("region-selector — content-protection isolation", () => {
  test("one throwing window cannot abort ON/OFF toggles or the capture", async () => {
    const throwingWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      setContentProtection: vi.fn(() => {
        throw new Error("fixture toggle failure");
      }),
      getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 400, height: 300 })
    };
    const healthyWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      setContentProtection: vi.fn(),
      getBounds: vi.fn().mockReturnValue({ x: 500, y: 0, width: 400, height: 300 })
    };
    browserWindowFromId.mockImplementation((id: number) => {
      if (id === 91) return throwingWindow;
      if (id === 92) return healthyWindow;
      return null;
    });

    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({
      mode: "region",
      keepPwrSnapChrome: true,
      protectWindowIds: [91, 92]
    });
    await vi.waitFor(() => {
      expect(constructed[0]?.show).toHaveBeenCalledTimes(1);
    });

    expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledTimes(1);
    expect(throwingWindow.setContentProtection.mock.calls).toEqual([[true], [false]]);
    expect(healthyWindow.setContentProtection.mock.calls).toEqual([[true], [false]]);

    ipcListeners.get("region-selector:result")?.({}, { ok: false, invocationId: 1 });
    await expect(pick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
  });

  test("a synchronous protected-window bounds failure still lifts protection exactly once", async () => {
    const protectedWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      setContentProtection: vi.fn(),
      getBounds: vi.fn(() => {
        throw new Error("fixture bounds failure");
      })
    };
    browserWindowFromId.mockImplementation((id: number) => (id === 91 ? protectedWindow : null));

    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({
      mode: "region",
      keepPwrSnapChrome: true,
      protectWindowIds: [91]
    });

    await expect(pick).rejects.toThrow("fixture bounds failure");
    expect(protectedWindow.setContentProtection.mock.calls).toEqual([[true], [false]]);
    expect(screenSnapshotMocks.captureAndRegister).not.toHaveBeenCalled();
  });
});

describe("prepareWindowListPayload — content-protected windows", () => {
  const protectionDisplay = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 25, width: 1440, height: 875 },
    scaleFactor: 2
  } as unknown as Display;

  // prepareWindowListPayload reads getBounds/getContentBounds/
  // isSimpleFullScreen off the selector window (the last two only feed a
  // debug log, but their args are still evaluated).
  const protectionSelectorWindow = {
    getBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    getContentBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    isSimpleFullScreen: () => false
  } as unknown as BrowserWindow;

  // Library = ours, topmost (z=0). A non-empty title short-circuits
  // isSelectorOverlayWindow, so it's never mistaken for the overlay.
  const library: WindowInfo = {
    windowId: 10,
    pid: 4242,
    bundleId: "com.pwrdrvr.pwrsnap",
    appName: "PwrSnap",
    title: "PwrSnap Library",
    bounds: { x: 240, y: 30, width: 1000, height: 700 },
    layer: 0,
    alpha: 1,
    isFrontmostInApp: true
  };
  const otherApp: WindowInfo = {
    windowId: 20,
    pid: 5555,
    bundleId: "com.anthropic.claude",
    appName: "Claude",
    title: "Claude",
    bounds: { x: 100, y: 50, width: 1200, height: 800 },
    layer: 0,
    alpha: 1,
    isFrontmostInApp: true
  };

  test("drops the protected Library from candidates but keeps its PwrSnap origin", async () => {
    const { prepareWindowListPayload } = await import("../capture/region-selector");
    const result = prepareWindowListPayload({
      rawSnapshot: [library, otherApp],
      targetDisplay: protectionDisplay,
      displayCursor: { x: 100, y: 100 },
      ourPids: new Set([4242]),
      excludeWindowIds: [],
      excludeWindowBounds: [library.bounds],
      selectorWindow: protectionSelectorWindow,
      frontmostPid: 4242,
      frontmostBundleId: "com.pwrdrvr.pwrsnap"
    });

    // Library (ours, topmost) ⇒ "we were already in PwrSnap", no
    // previous app to restore. Computed on the UNFILTERED snapshot, so
    // the candidate exclusion must not perturb it.
    expect(result.previousAppPid).toBeNull();
    expect(result.previousAppOrigin).toBe("pwrsnap");
    // Library is absent from the frozen picker image, so it must NOT be
    // a snap target — only the other app remains pickable.
    expect(result.payload.windows.map((w) => w.windowId)).toEqual([20]);
  });

  test("without exclusion the Library IS a candidate (proves exclusion is what drops it)", async () => {
    const { prepareWindowListPayload } = await import("../capture/region-selector");
    const result = prepareWindowListPayload({
      rawSnapshot: [library, otherApp],
      targetDisplay: protectionDisplay,
      displayCursor: { x: 100, y: 100 },
      ourPids: new Set([4242]),
      excludeWindowIds: [],
      excludeWindowBounds: [],
      selectorWindow: protectionSelectorWindow,
      frontmostPid: 4242,
      frontmostBundleId: "com.pwrdrvr.pwrsnap"
    });

    expect([...result.payload.windows.map((w) => w.windowId)].sort()).toEqual([10, 20]);
  });
});

describe("windowSnapshotInElectronDip — Windows native bounds", () => {
  const physicalWindow: WindowInfo = {
    windowId: 30,
    pid: 6000,
    bundleId: "C:\\Program Files\\Fixture\\fixture.exe",
    appName: "fixture",
    title: "Placed fixture window",
    bounds: { x: 150, y: 225, width: 900, height: 600 },
    layer: 0,
    alpha: 1,
    isFrontmostInApp: true
  };

  test("converts physical HWND bounds to Electron DIPs before picker filtering and rendering", async () => {
    const { windowSnapshotInElectronDip } = await import("../capture/region-selector");
    const screenToDipRect = vi.fn().mockReturnValue({
      x: 100,
      y: 150,
      width: 600,
      height: 400
    });

    const result = windowSnapshotInElectronDip([physicalWindow], "win32", screenToDipRect);

    expect(screenToDipRect).toHaveBeenCalledWith(physicalWindow.bounds);
    expect(result[0]?.bounds).toEqual({
      x: 100,
      y: 150,
      width: 600,
      height: 400
    });
    expect(physicalWindow.bounds).toEqual({
      x: 150,
      y: 225,
      width: 900,
      height: 600
    });
  });

  test("leaves macOS logical bounds unchanged without calling the Windows converter", async () => {
    const { windowSnapshotInElectronDip } = await import("../capture/region-selector");
    const screenToDipRect = vi.fn();

    const result = windowSnapshotInElectronDip([physicalWindow], "darwin", screenToDipRect);

    expect(screenToDipRect).not.toHaveBeenCalled();
    expect(result[0]?.bounds).toEqual(physicalWindow.bounds);
  });
});
