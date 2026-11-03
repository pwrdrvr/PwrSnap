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
import type { ScreenSnapshot } from "../capture/screen-snapshot";
import type { WindowInfo } from "../capture/window-list";

type WindowSpy = {
  setTitle: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
  setSimpleFullScreen: ReturnType<typeof vi.fn>;
  isSimpleFullScreen: ReturnType<typeof vi.fn>;
  setContentBounds: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  getBounds: ReturnType<typeof vi.fn>;
  getContentBounds: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
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
const protectedWindows = new Map<number, { isDestroyed: () => boolean; setContentProtection: ReturnType<typeof vi.fn>; getBounds: () => object }>();
const ipcListeners = new Map<string, (event: unknown, payload: unknown) => void>();
const ipcHandlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const deferredLoadResolvers: (() => void)[] = [];
let deferSelectorLoads = false;
// When true, the window spy stops auto-acking `region-selector:painted`
// on a mode push — lets a test simulate a renderer that never paints
// (timeout fallback) or drive the ack manually (stale-URL rejection).
let suppressPaintAck = false;
const screenSnapshotMocks = vi.hoisted(() => ({
  captureAndRegister: vi.fn(),
  releaseSnapshot: vi.fn(),
  releaseAllSnapshots: vi.fn(),
  readSnapshotForRenderer: vi.fn(),
  recordSnapshotCanvasUpload: vi.fn()
}));
const selectorShortcutMocks = vi.hoisted(() => {
  const callbacks = new Map<string, () => void>();
  return {
    callbacks,
    register: vi.fn((accelerator: string, callback: () => void) => {
      callbacks.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      callbacks.delete(accelerator);
    })
  };
});

function selectorLoadPromise(): Promise<void> {
  if (!deferSelectorLoads) return Promise.resolve();
  return new Promise((resolve) => {
    deferredLoadResolvers.push(resolve);
  });
}

function makeWindowSpy(options: Record<string, unknown>): WindowSpy {
  const webContentsId = 100 + constructed.length;
  return {
    setTitle: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setSimpleFullScreen: vi.fn(),
    isSimpleFullScreen: vi.fn().mockReturnValue(false),
    setContentBounds: vi.fn(),
    setBounds: vi.fn(),
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1440, height: 900 }),
    getContentBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1440, height: 900 }),
    show: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    hide: vi.fn(),
    moveTop: vi.fn(),
    loadURL: vi.fn(() => selectorLoadPromise()),
    loadFile: vi.fn(() => selectorLoadPromise()),
    webContents: {
      id: webContentsId,
      on: vi.fn(),
      // Simulate the selector renderer: when main pushes the per-show
      // mode with a snapshot URL, the real renderer loads the frozen
      // <img> and acks `region-selector:painted` — which main now gates
      // `show()` on. Mirror that ack here (next microtask, after main
      // has registered its paint waiter) so the gated show proceeds
      // without a real renderer/image decode.
      send: vi.fn((channel: string, payload: unknown) => {
        if (suppressPaintAck) return;
        if (channel === "region-selector:mode" && payload !== null && typeof payload === "object") {
          const url = (payload as { screenUrl?: unknown }).screenUrl;
          if (typeof url === "string") {
            queueMicrotask(() =>
              ipcListeners.get("region-selector:painted")?.(
                { sender: { id: webContentsId } },
                {
                  screenUrl: url,
                  transport: "img",
                  decodeMs: 1,
                  mainToRendererBytes: 0,
                  canvasUploadBytes: 0
                }
              )
            );
          }
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
}

vi.mock("electron", () => {
  class BrowserWindow {
    static fromId(id: number) { return protectedWindows.get(id) ?? null; }
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
      getAllDisplays: () => [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1440, height: 900 },
          workArea: { x: 0, y: 25, width: 1440, height: 875 },
          scaleFactor: 2
        }
      ],
      getDisplayNearestPoint: () => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 25, width: 1440, height: 875 },
        scaleFactor: 2
      }),
      getDisplayMatching: () => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 25, width: 1440, height: 875 },
        scaleFactor: 2
      }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      on: vi.fn()
    },
    BrowserWindow,
    globalShortcut: {
      register: selectorShortcutMocks.register,
      unregister: selectorShortcutMocks.unregister
    },
    ipcMain: {
      on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
        ipcListeners.set(channel, listener);
      }),
      handle: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => unknown) => {
        ipcHandlers.set(channel, listener);
      }),
      removeAllListeners: vi.fn(),
      removeHandler: vi.fn()
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
  listWindowsSnapshot: vi
    .fn()
    .mockResolvedValue({ windows: [], frontmostPid: null, frontmostBundleId: null }),
  selfPidSet: () => new Set<number>()
}));

vi.mock("../capture/screen-snapshot", () => ({
  captureAndRegister: screenSnapshotMocks.captureAndRegister,
  releaseSnapshot: screenSnapshotMocks.releaseSnapshot,
  releaseAllSnapshots: screenSnapshotMocks.releaseAllSnapshots,
  readSnapshotForRenderer: screenSnapshotMocks.readSnapshotForRenderer,
  recordSnapshotCanvasUpload: screenSnapshotMocks.recordSnapshotCanvasUpload
}));

// Hoisted (not inline `vi.fn()`) so the SAME spy survives the
// `vi.resetModules()` in beforeEach — the ordering assertions below
// compare its invocation order against the snapshot mock's, which only
// works if both identities are stable across the re-import.
const chromeMocks = vi.hoisted(() => ({
  hideTrayPopoverIfVisible: vi.fn(),
  setFloatOverState: vi.fn()
}));

vi.mock("../tray", () => ({
  hideTrayPopoverIfVisible: chromeMocks.hideTrayPopoverIfVisible
}));

vi.mock("../float-over", () => ({
  setFloatOverState: chromeMocks.setFloatOverState
}));

const realPlatform = process.platform;

beforeEach(() => {
  constructed.length = 0;
  protectedWindows.clear();
  ipcListeners.clear();
  ipcHandlers.clear();
  deferredLoadResolvers.length = 0;
  deferSelectorLoads = false;
  suppressPaintAck = false;
  screenSnapshotMocks.captureAndRegister.mockReset();
  screenSnapshotMocks.releaseSnapshot.mockReset();
  screenSnapshotMocks.releaseAllSnapshots.mockReset();
  screenSnapshotMocks.readSnapshotForRenderer.mockReset();
  screenSnapshotMocks.recordSnapshotCanvasUpload.mockReset();
  // mockReset, not mockClear: the compositor-flush test below installs a
  // `mockImplementation` on hideTrayPopoverIfVisible, and mockClear drops
  // only the call records — the implementation would survive into every
  // later test and make this file order-dependent. Same reason the
  // screenSnapshot mocks above reset.
  chromeMocks.hideTrayPopoverIfVisible.mockReset();
  chromeMocks.setFloatOverState.mockReset();
  selectorShortcutMocks.callbacks.clear();
  selectorShortcutMocks.register.mockClear();
  selectorShortcutMocks.unregister.mockClear();
  screenSnapshotMocks.captureAndRegister.mockResolvedValue({
    id: "snapshot-1",
    displayId: 1,
    transport: "png-file",
    acquisition: {
      sourceBitmapBytes: 0,
      mappingWriteBytes: 0,
      fullScreenPngEncodeCount: 1,
      fullScreenPngBytes: 100,
      fullScreenTempFileWriteBytes: 100
    }
  });
  vi.resetModules();
  // createSelectorWindow only sets the NSPanel (`type: 'panel'`) +
  // setVisibleOnAllWorkspaces flags this test guards on darwin — they're
  // macOS-only (Windows/Linux use a plain frameless overlay). Pin the
  // platform so the macOS Splashtop guard is actually exercised.
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});

afterEach(async () => {
  const { disposeRegionSelector } = await import("../capture/region-selector");
  disposeRegionSelector();
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

function activeSelectorWindow(): WindowSpy {
  return [...constructed].reverse().find((win) => win.webContents.send.mock.calls.some(([channel]) => channel === "region-selector:mode")) ?? constructed[0]!;
}

function latestMode(win = activeSelectorWindow()) {
  return win.webContents.send.mock.calls.filter(([channel]) => channel === "region-selector:mode").at(-1)?.[1] as { screenUrl: string } | undefined;
}

function emitSelectorResult(payload: object, win = activeSelectorWindow()): void {
  ipcListeners.get("region-selector:result")?.(selectorEvent(win), {
    screenUrl: latestMode(win)?.screenUrl,
    ...payload
  });
}

function selectorEvent(win = activeSelectorWindow()) {
  const mainFrame = { processId: 10, routingId: 20 };
  return { sender: { id: win.webContents.id, isDestroyed: () => false, mainFrame }, senderFrame: mainFrame };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function snapshot(id: string): ScreenSnapshot {
  return {
    id, displayId: 1, transport: "png-file",
    acquisition: { sourceBitmapBytes: 0, retainedBitmapBytes: 0, bitmapNormalizeMs: 0, mappingWriteBytes: 0, fullScreenPngEncodeCount: 1, fullScreenPngBytes: 100, fullScreenTempFileWriteBytes: 100 }
  };
}

async function flushSelector(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

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

  test("disables background throttling on Windows so a reused hidden selector can schedule its presentation frames", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();

    const spy = constructed[0]!;
    expect(spy.options.webPreferences).toMatchObject({
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
    const pick = pickRegion();

    await vi.waitFor(() => {
      expect(constructed[0]?.moveTop).toHaveBeenCalledTimes(1);
    });

    const spy = constructed[0]!;
    const showOrder = spy.show.mock.invocationCallOrder[0];
    const focusOrder = spy.focus.mock.invocationCallOrder[0];
    const webFocusOrder = spy.webContents.focus.mock.invocationCallOrder[0];
    const moveTopOrder = spy.moveTop.mock.invocationCallOrder[0];

    expect(showOrder).toBeDefined();
    expect(focusOrder).toBeDefined();
    expect(webFocusOrder).toBeDefined();
    expect(moveTopOrder).toBeDefined();
    expect(moveTopOrder!).toBeGreaterThan(showOrder!);
    expect(moveTopOrder!).toBeGreaterThan(focusOrder!);
    expect(moveTopOrder!).toBeGreaterThan(webFocusOrder!);

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });

  test("the Settings recorder lease releases and restores selector Escape and Return ownership", async () => {
    const [{ pickRegion }, { hotkeyRecorderSuspension }] = await Promise.all([
      import("../capture/region-selector"),
      import("../hotkeys/hotkey-recorder-suspension-instance")
    ]);
    hotkeyRecorderSuspension.configureOwnership({
      registrationManager: null,
      withSerializedSettings: async (operation) => operation({} as never)
    });
    const pick = pickRegion();

    await vi.waitFor(() => {
      expect(selectorShortcutMocks.callbacks.has("Escape")).toBe(true);
      expect(selectorShortcutMocks.callbacks.has("Return")).toBe(true);
    });
    const selector = constructed[0]!;
    const originalEscape = selectorShortcutMocks.callbacks.get("Escape");

    const lease = await hotkeyRecorderSuspension.begin(
      "settings_session_1",
      1,
      17,
      "documentepoch0001"
    );
    expect(lease.accepted).toBe(true);
    expect(selectorShortcutMocks.unregister.mock.calls.map(([key]) => key)).toEqual([
      "Escape",
      "Return"
    ]);
    expect(selectorShortcutMocks.callbacks.size).toBe(0);
    originalEscape?.();
    expect(selector.webContents.send).not.toHaveBeenCalledWith(
      "region-selector:key",
      { key: "Escape" }
    );

    await expect(
      hotkeyRecorderSuspension.end(
        "settings_session_1",
        1,
        17,
        "documentepoch0001"
      )
    ).resolves.toBe(true);
    expect(selectorShortcutMocks.callbacks.has("Escape")).toBe(true);
    expect(selectorShortcutMocks.callbacks.has("Return")).toBe(true);
    selectorShortcutMocks.callbacks.get("Escape")?.();
    expect(selector.webContents.send).toHaveBeenCalledWith(
      "region-selector:key",
      { key: "Escape" }
    );

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
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

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });

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
    let resolveSnapshot!: (value: {
      id: string;
      filePath: string;
      displayId: number;
    }) => void;
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

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
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

    emitSelectorResult({ ok: false });
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
          screenUrl: "pwrsnap-screen://r/snapshot-1"
        })
      );
      expect(standby.show).toHaveBeenCalledTimes(1);
    });
    if (constructed[2] !== undefined) {
      expect(constructed[2].show).not.toHaveBeenCalled();
    }

    emitSelectorResult({ ok: false });
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

    emitSelectorResult({ ok: false });
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
          screenUrl: "pwrsnap-screen://r/snapshot-1"
        })
      );
      expect(standby.show).toHaveBeenCalledTimes(1);
    });

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });
});

describe("region-selector — snapshot-paint gate before show()", () => {
  test("reveals via the timeout fallback when the renderer never acks the paint", async () => {
    // Simulate a wedged renderer: the mode/snapshot is pushed (so it
    // COULD paint) but the `region-selector:painted` ack never fires.
    suppressPaintAck = true;
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion();

    // The mode + snapshot URL reaches the renderer...
    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({ screenUrl: "pwrsnap-screen://r/snapshot-1" })
      );
    });

    // ...and even with no paint ack, the selector still shows once the
    // SHOW_AFTER_PAINT_TIMEOUT_MS safety net elapses (identical to the
    // pre-gate behavior — never hangs the picker).
    await vi.waitFor(
      () => {
        expect(constructed[0]?.show).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000 }
    );

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
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

    // A late ack from a SUPERSEDED capture (different screenUrl) must not
    // satisfy the current wait — the selector stays hidden. (Well under
    // the 250ms timeout, so the fallback can't be what keeps it hidden.)
    const paintEvent = { sender: { id: constructed[0]!.webContents.id } };
    ipcListeners.get("region-selector:painted")?.(paintEvent, {
      screenUrl: "pwrsnap-screen://r/stale-0"
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(constructed[0]?.show).not.toHaveBeenCalled();

    // The ack for the CURRENT snapshot reveals it.
    ipcListeners.get("region-selector:painted")?.(paintEvent, {
      screenUrl: "pwrsnap-screen://r/snapshot-1"
    });
    await vi.waitFor(() => {
      expect(constructed[0]?.show).toHaveBeenCalledTimes(1);
    });

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });
});

describe("region-selector — mapped snapshot IPC boundary", () => {
  test("admits only the active selector top-level frame and active opaque id", async () => {
    screenSnapshotMocks.captureAndRegister.mockResolvedValueOnce({
      id: "mapped-snapshot-1",
      displayId: 1,
      transport: "raw-rgba",
      selectorDescriptor: {
        id: "mapped-snapshot-1",
        transport: "raw-rgba",
        version: 1,
        width: 2,
        height: 1,
        stride: 8,
        pixelFormat: 1,
        byteLength: 8
      },
      acquisition: {
        sourceBitmapBytes: 8,
        mappingWriteBytes: 72,
        fullScreenPngEncodeCount: 0,
        fullScreenPngBytes: 0,
        fullScreenTempFileWriteBytes: 0
      }
    });
    screenSnapshotMocks.readSnapshotForRenderer.mockResolvedValue({
      ok: true,
      header: {
        version: 1,
        width: 2,
        height: 1,
        stride: 8,
        pixelFormat: 1,
        byteLength: 8
      },
      data: Buffer.alloc(8)
    });
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ keepPwrSnapChrome: true });
    await vi.waitFor(() => {
      expect(ipcHandlers.has("region-selector:snapshot-read")).toBe(true);
      expect(constructed[0]?.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({
          snapshot: expect.objectContaining({ id: "mapped-snapshot-1" })
        })
      );
    });
    const handler = ipcHandlers.get("region-selector:snapshot-read")!;
    const mainFrame = { processId: 10, routingId: 20 };
    const sender = {
      id: constructed[0]!.webContents.id,
      isDestroyed: () => false,
      mainFrame
    };

    await expect(
      handler(
        {
          sender: { id: sender.id + 1, isDestroyed: () => false, mainFrame },
          senderFrame: mainFrame
        },
        { id: "mapped-snapshot-1" }
      )
    ).resolves.toEqual({ ok: false, code: "unauthorized" });
    await expect(
      handler(
        { sender, senderFrame: { processId: 10, routingId: 21 } },
        { id: "mapped-snapshot-1" }
      )
    ).resolves.toEqual({ ok: false, code: "unauthorized" });
    await expect(
      handler({ sender, senderFrame: mainFrame }, { id: "mapped-snapshot-2" })
    ).resolves.toEqual({ ok: false, code: "unauthorized" });
    expect(screenSnapshotMocks.readSnapshotForRenderer).not.toHaveBeenCalled();

    await expect(
      handler({ sender, senderFrame: mainFrame }, { id: "mapped-snapshot-1" })
    ).resolves.toMatchObject({ ok: true });
    expect(screenSnapshotMocks.readSnapshotForRenderer).toHaveBeenCalledWith(
      "mapped-snapshot-1"
    );

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });
});

describe("region-selector — authenticated post-show presentation trace", () => {
  function invocation() {
    return {
      id: "trace-selector-1234",
      origin: "global_hotkey.window" as const,
      triggerMonotonicMs: 1000,
      dispatchMonotonicMs: 1001,
      triggerWallTime: "2026-09-01T12:00:00.000Z"
    };
  }

  test("retains late bitmap readiness after timeout, rejects stale/duplicate acks, and summarizes frame timings", async () => {
    suppressPaintAck = true;
    const entries: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const { CaptureLatencyTrace } = await import("../capture/capture-latency-trace");
    const trace = new CaptureLatencyTrace(invocation(), "window", {
      logger: {
        debug: (message, fields) => entries.push({ message, fields }),
        info: (message, fields) => entries.push({ message, fields })
      }
    });
    screenSnapshotMocks.captureAndRegister.mockResolvedValueOnce({
      id: "late-mapped", displayId: 1, transport: "raw-rgba",
      selectorDescriptor: {
        id: "late-mapped", transport: "raw-rgba", version: 1,
        width: 2, height: 1, stride: 8, pixelFormat: 1, byteLength: 8
      }
    });
    const { pickRegion, hideSelector } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "window", latencyTrace: trace });
    const spy = constructed[0]!;
    await vi.waitFor(() => expect(spy.show).toHaveBeenCalledTimes(1));
    const request = spy.webContents.send.mock.calls.find(
      ([channel]) => channel === "region-selector:presentation-request"
    )?.[1] as Record<string, unknown>;
    screenSnapshotMocks.readSnapshotForRenderer.mockResolvedValueOnce({ ok: true });
    const mainFrame = { processId: 10, routingId: 20 };
    await ipcHandlers.get("region-selector:snapshot-read")!({
      sender: { id: spy.webContents.id, isDestroyed: () => false, mainFrame },
      senderFrame: mainFrame
    }, { id: "late-mapped" });
    const painted = ipcListeners.get("region-selector:painted")!;
    const payload = {
      screenUrl: "pwrsnap-screen://r/late-mapped", transport: "raw-rgba",
      decodeMs: 900, readRoundTripMs: 850, canvasUploadMs: 50,
      mainToRendererBytes: 8, canvasUploadBytes: 8
    };
    painted({ sender: { id: spy.webContents.id + 1 } }, payload);
    painted({ sender: { id: spy.webContents.id } }, { ...payload, screenUrl: "stale" });
    expect(screenSnapshotMocks.recordSnapshotCanvasUpload).not.toHaveBeenCalled();
    painted({ sender: { id: spy.webContents.id } }, payload);
    painted({ sender: { id: spy.webContents.id } }, payload);
    expect(spy.show).toHaveBeenCalledTimes(1);
    expect(screenSnapshotMocks.recordSnapshotCanvasUpload).toHaveBeenCalledTimes(1);
    expect(screenSnapshotMocks.recordSnapshotCanvasUpload).toHaveBeenCalledWith("late-mapped", 8);
    ipcListeners.get("region-selector:presented")?.({ sender: { id: spy.webContents.id } }, {
      ...request, snapshotWaitMs: 600, firstFrameWaitMs: 20, secondFrameWaitMs: 30,
      rendererTotalMs: Number.POSITIVE_INFINITY
    });
    expect(entries.find((entry) => entry.fields.stage === "frozen_source_decode_ready")?.fields)
      .toMatchObject({ outcome: "timeout", renderer: "canvas" });
    expect(entries.find((entry) => entry.fields.event === "capture_latency_summary")?.fields)
      .toMatchObject({
        snapshotReadiness: {
          transport: "raw-rgba", gateOutcome: "timeout", late: true,
          mainBitmapReadMs: expect.any(Number), mainBitmapReadOutcome: "read",
          readRoundTripMs: 850, canvasUploadMs: 50, rendererReadyMs: 900
        },
        presentation: {
          snapshotWaitMs: 600, firstFrameWaitMs: 20, secondFrameWaitMs: 30,
          rendererTotalMs: null
        }
      });
    emitSelectorResult({ ok: false });
    await pick;
    hideSelector();
    painted({ sender: { id: spy.webContents.id } }, payload);
    expect(screenSnapshotMocks.recordSnapshotCanvasUpload).toHaveBeenCalledTimes(1);
  });

  test("requests acknowledgement after show/focus/moveTop and rejects stale or wrong senders", async () => {
    const entries: Array<{ message: string; fields: Record<string, unknown> }> = [];
    let tick = 1010;
    const { CaptureLatencyTrace } = await import(
      "../capture/capture-latency-trace"
    );
    const trace = new CaptureLatencyTrace(invocation(), "window", {
      monotonicNow: () => ++tick,
      wallNow: () => "2026-09-01T12:00:01.000Z",
      logger: {
        debug: (message, fields) => entries.push({ message, fields }),
        info: (message, fields) => entries.push({ message, fields })
      }
    });
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ mode: "window", latencyTrace: trace });

    const spy = constructed[0]!;
    await vi.waitFor(() => {
      expect(spy.webContents.send).toHaveBeenCalledWith(
        "region-selector:presentation-request",
        expect.objectContaining({
          invocationId: invocation().id,
          screenUrl: "pwrsnap-screen://r/snapshot-1"
        })
      );
    });
    expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledWith(1, trace);
    const requestIndex = spy.webContents.send.mock.calls.findIndex(
      ([channel]) => channel === "region-selector:presentation-request"
    );
    const request = spy.webContents.send.mock.calls[requestIndex]?.[1] as {
      invocationId: string;
      generation: number;
      screenUrl: string;
    };
    const requestOrder = spy.webContents.send.mock.invocationCallOrder[requestIndex];
    expect(requestOrder).toBeGreaterThan(spy.show.mock.invocationCallOrder[0]!);
    expect(requestOrder).toBeGreaterThan(spy.focus.mock.invocationCallOrder[0]!);
    expect(requestOrder).toBeGreaterThan(spy.webContents.focus.mock.invocationCallOrder[0]!);
    expect(requestOrder).toBeGreaterThan(spy.moveTop.mock.invocationCallOrder[0]!);

    const presented = ipcListeners.get("region-selector:presented");
    presented?.({ sender: { id: spy.webContents.id + 1 } }, request);
    presented?.(
      { sender: { id: spy.webContents.id } },
      { ...request, invocationId: "trace-stale-9999" }
    );
    presented?.(
      { sender: { id: spy.webContents.id } },
      { ...request, generation: request.generation - 1 }
    );
    presented?.(
      { sender: { id: spy.webContents.id } },
      { ...request, screenUrl: "pwrsnap-screen://r/stale" }
    );
    expect(
      entries.filter((entry) => entry.fields.event === "capture_latency_summary")
    ).toHaveLength(0);

    presented?.({ sender: { id: spy.webContents.id } }, request);
    const summaries = entries.filter(
      (entry) => entry.fields.event === "capture_latency_summary"
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.fields).toMatchObject({
      outcome: "presented",
      invocationId: invocation().id,
      generation: request.generation,
      frameBarrier: 2
    });
    expect(
      entries.find((entry) => entry.fields.stage === "first_visible_paint_ack")?.fields
    ).toMatchObject({ authenticated: true, frameBarrier: 2 });
    const decodeStages = entries.filter(
      (entry) => entry.fields.stage === "frozen_source_decode_ready"
    );
    expect(decodeStages).toHaveLength(1);
    expect(decodeStages[0]?.fields).toMatchObject({
      outcome: "loaded",
      renderer: "img",
      signal: "load",
      canvas: "not_used"
    });

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
    expect(
      entries.filter((entry) => entry.fields.event === "capture_latency_summary")
    ).toHaveLength(1);
  });

  test("missing diagnostic acknowledgement never gates show or cancellation", async () => {
    const entries: Array<{ message: string; fields: Record<string, unknown> }> = [];
    let tick = 1010;
    const { CaptureLatencyTrace } = await import(
      "../capture/capture-latency-trace"
    );
    const trace = new CaptureLatencyTrace(invocation(), "auto", {
      monotonicNow: () => ++tick,
      wallNow: () => "2026-09-01T12:00:01.000Z",
      logger: {
        debug: (message, fields) => entries.push({ message, fields }),
        info: (message, fields) => entries.push({ message, fields })
      }
    });
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ latencyTrace: trace });

    await vi.waitFor(() => expect(constructed[0]?.show).toHaveBeenCalledTimes(1));
    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });

    const summaries = entries.filter(
      (entry) => entry.fields.event === "capture_latency_summary"
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.fields).toMatchObject({
      outcome: "cancel",
      reason: "cancelled"
    });
  });

  test("screen acquisition failure emits an error summary without showing the selector", async () => {
    screenSnapshotMocks.captureAndRegister.mockRejectedValueOnce(
      new Error("fixture acquisition failure")
    );
    const entries: Array<{ message: string; fields: Record<string, unknown> }> = [];
    let tick = 1010;
    const { CaptureLatencyTrace } = await import(
      "../capture/capture-latency-trace"
    );
    const trace = new CaptureLatencyTrace(invocation(), "auto", {
      monotonicNow: () => ++tick,
      wallNow: () => "2026-09-01T12:00:01.000Z",
      logger: {
        debug: (message, fields) => entries.push({ message, fields }),
        info: (message, fields) => entries.push({ message, fields })
      }
    });
    const { pickRegion } = await import("../capture/region-selector");

    await expect(pickRegion({ latencyTrace: trace })).resolves.toMatchObject({
      ok: false,
      reason: "destroyed"
    });
    expect(constructed[0]?.show).not.toHaveBeenCalled();
    expect(
      entries.find((entry) => entry.fields.event === "capture_latency_summary")
        ?.fields
    ).toMatchObject({
      outcome: "error",
      code: "screen_frame_acquisition_failed"
    });
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

  test("drops the protected Library from candidates but keeps it for previousAppPid", async () => {
    const { prepareWindowListPayload } = await import("../capture/region-selector");
    const result = prepareWindowListPayload({
      rawSnapshot: [library, otherApp],
      targetDisplay: protectionDisplay,
      displayCursor: { x: 100, y: 100 },
      ourPids: new Set([4242]),
      excludeWindowBounds: [library.bounds],
      selectorWindow: protectionSelectorWindow,
      frontmostPid: 4242,
      frontmostBundleId: "com.pwrdrvr.pwrsnap"
    });

    // Library (ours, topmost) ⇒ "we were already in PwrSnap", no
    // previous app to restore. Computed on the UNFILTERED snapshot, so
    // the candidate exclusion must not perturb it.
    expect(result.previousAppPid).toBeNull();
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

    const result = windowSnapshotInElectronDip(
      [physicalWindow],
      "win32",
      screenToDipRect
    );

    expect(screenToDipRect).toHaveBeenCalledWith(physicalWindow.bounds);
    expect(result[0]?.bounds).toEqual({ x: 100, y: 150, width: 600, height: 400 });
    expect(physicalWindow.bounds).toEqual({ x: 150, y: 225, width: 900, height: 600 });
  });

  test("leaves macOS logical bounds unchanged without calling the Windows converter", async () => {
    const { windowSnapshotInElectronDip } = await import("../capture/region-selector");
    const screenToDipRect = vi.fn();

    const result = windowSnapshotInElectronDip(
      [physicalWindow],
      "darwin",
      screenToDipRect
    );

    expect(screenToDipRect).not.toHaveBeenCalled();
    expect(result[0]?.bounds).toEqual(physicalWindow.bounds);
  });
});

// The region/auto capture path does NOT re-shoot the screen after the
// user commits — it crops the frozen snapshot taken here (see the
// COMMIT branch of `capture:interactive`). So whatever PwrSnap chrome
// is still on screen when `captureAndRegister` runs is baked into the
// saved capture, permanently. Two things have to hold, and this pins
// both: the dismiss has to happen BEFORE the freeze, and the freeze has
// to wait out a compositor flush so the WindowServer has actually
// dropped those windows from the framebuffer.
//
// The dismiss being INSTANT is the other half, and lives with the tray:
// `hideTrayWindowNow` in tray.ts, pinned by tray-instant-hide.test.ts.
// Ordering alone is not enough — a fading NSPanel is ordered out at the
// START of its fade, so it would satisfy every assertion here while
// still painting itself into the snapshot.
describe("region-selector — PwrSnap chrome leaves the frame before the screen freezes", () => {
  test("dismisses the tray popover and parks the float-over before the snapshot", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({});

    await vi.waitFor(() => {
      expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledTimes(1);
    });

    expect(chromeMocks.hideTrayPopoverIfVisible).toHaveBeenCalledTimes(1);
    expect(chromeMocks.setFloatOverState).toHaveBeenCalledWith({ kind: "cancel", chromeHide: true });

    const hideOrder = chromeMocks.hideTrayPopoverIfVisible.mock.invocationCallOrder[0]!;
    const parkOrder = chromeMocks.setFloatOverState.mock.invocationCallOrder[0]!;
    const freezeOrder = screenSnapshotMocks.captureAndRegister.mock.invocationCallOrder[0]!;
    expect(hideOrder).toBeLessThan(freezeOrder);
    expect(parkOrder).toBeLessThan(freezeOrder);

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });

  test("waits a compositor flush between the dismiss and the snapshot", async () => {
    // `hide()` only tells AppKit to order the window out; the window
    // server still has to composite a frame without it. Freezing on the
    // same tick captures whatever is still on screen. Assert the real
    // elapsed gap rather than a call order — a timer can fire late but
    // never early, so this can't flake in the direction of a pass.
    let hiddenAt = 0;
    let frozenAt = 0;
    chromeMocks.hideTrayPopoverIfVisible.mockImplementation(() => {
      hiddenAt = performance.now();
    });
    screenSnapshotMocks.captureAndRegister.mockImplementationOnce(async () => {
      frozenAt = performance.now();
      return { id: "snapshot-1", filePath: "/tmp/snapshot.png", displayId: 1 };
    });

    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({});

    await vi.waitFor(() => {
      expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledTimes(1);
    });

    expect(hiddenAt).toBeGreaterThan(0);
    // The flush budget is 50ms; allow a hair of scheduler slop so a
    // starved CI runner's clock rounding can't fail a correct build.
    expect(frozenAt - hiddenAt).toBeGreaterThanOrEqual(45);

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });

  test("timed mode keeps the tray up — the countdown exists to capture it", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledTimes(1);
    });
    expect(chromeMocks.hideTrayPopoverIfVisible).not.toHaveBeenCalled();

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });
});

describe("region-selector — Snap-vs-Record commit payload (issue #75)", () => {
  test("forwards the chooser policy to the renderer in the per-show mode signal", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ quickCaptureAction: "record", cursorDefault: false });

    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalled();
    });
    const modeSend = constructed[0]!.webContents.send.mock.calls.find(
      (call) => call[0] === "region-selector:mode"
    );
    expect(modeSend?.[1]).toMatchObject({
      mode: "auto",
      quickCaptureAction: "record",
      cursor: false
    });

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false });
  });

  test("a record commit carries the action through to the result", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ quickCaptureAction: "ask" });
    await vi.waitFor(() => expect(constructed[0]?.show).toHaveBeenCalled());

    emitSelectorResult(
      {
        ok: true,
        rect: { x: 10, y: 20, w: 300, h: 200 },
        displayId: 1,
        action: "record",
        captureCursor: false
      }
    );
    await expect(pick).resolves.toMatchObject({
      ok: true,
      action: "record",
      captureCursor: false
    });
  });

  test("a snap commit carries no action at all", async () => {
    // The wire shape a pre-chooser selector produced, unchanged.
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion();
    await vi.waitFor(() => expect(constructed[0]?.show).toHaveBeenCalled());

    emitSelectorResult(
      { ok: true, rect: { x: 10, y: 20, w: 300, h: 200 }, displayId: 1 }
    );
    const result = await pick;
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("action");
  });

  test("rejects a commit whose action is neither snap nor record", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion();
    await vi.waitFor(() => expect(constructed[0]?.show).toHaveBeenCalled());

    emitSelectorResult(
      { ok: true, rect: { x: 10, y: 20, w: 300, h: 200 }, displayId: 1, action: "video" }
    );
    // An unparseable payload is a cancel, not a partially-honored commit.
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });

  test("strips a record action from a multi-window commit and keeps the extents", async () => {
    // The seam multi-select left behind: `rect` here is the union
    // BOUNDING BOX, and the recording path is the only consumer that
    // never reads `extents` — so honoring this would record exactly the
    // gaps the picker painted transparent. The renderer disables Record
    // above one pick; this is the transport backstop, because only main
    // sees both facts in one message.
    //
    // Dropping the ACTION rather than the extents is the non-lying
    // degradation: the still honors every extent, so the user gets a
    // picture of what they picked instead of a video of what they
    // didn't.
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ quickCaptureAction: "ask" });
    await vi.waitFor(() => expect(constructed[0]?.show).toHaveBeenCalled());

    emitSelectorResult(
      {
        ok: true,
        rect: { x: 0, y: 0, w: 800, h: 600 },
        displayId: 1,
        action: "record",
        extents: [
          { x: 0, y: 0, w: 200, h: 200 },
          { x: 600, y: 400, w: 200, h: 200 }
        ],
        outputMode: "windows"
      }
    );
    const result = await pick;
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("action");
    expect(result).toMatchObject({ outputMode: "windows" });
    expect((result as { extents?: unknown[] }).extents).toHaveLength(2);
  });

  test("a single-extent commit may still record", async () => {
    // One pick is one rectangle — the union box IS the extent, so there
    // is nothing for a recording to misrepresent. (The renderer never
    // sends `extents` for a lone pick; a payload that does must not be
    // punished for it.)
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ quickCaptureAction: "ask" });
    await vi.waitFor(() => expect(constructed[0]?.show).toHaveBeenCalled());

    emitSelectorResult(
      {
        ok: true,
        rect: { x: 0, y: 0, w: 200, h: 200 },
        displayId: 1,
        action: "record",
        extents: [{ x: 0, y: 0, w: 200, h: 200 }]
      }
    );
    await expect(pick).resolves.toMatchObject({ ok: true, action: "record" });
  });
});

describe("region-selector — recording source chips", () => {
  test("forwards the per-show seed to the renderer", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({
      intent: "video",
      sourcesDefault: { microphone: true, systemAudio: false }
    });

    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalled();
    });
    const modeSend = constructed[0]!.webContents.send.mock.calls.find(
      (call) => call[0] === "region-selector:mode"
    );
    expect(modeSend?.[1]).toMatchObject({
      sources: { microphone: true, systemAudio: false }
    });

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false });
  });

  test("a caller that omits the seed sends no `sources` key", async () => {
    // Omitting it is what hides the chips. Sending `sources: undefined`
    // would be indistinguishable at the type level but reads as a
    // present-but-empty answer to anything doing a key check.
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ intent: "video" });
    await vi.waitFor(() => {
      expect(constructed[0]?.webContents.send).toHaveBeenCalled();
    });
    const modeSend = constructed[0]!.webContents.send.mock.calls.find(
      (call) => call[0] === "region-selector:mode"
    );
    expect(modeSend?.[1]).not.toHaveProperty("sources");

    emitSelectorResult({ ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false });
  });

  test("carries the committed answer through to the result", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ intent: "video" });
    await vi.waitFor(() => expect(constructed[0]?.show).toHaveBeenCalled());

    emitSelectorResult(
      {
        ok: true,
        rect: { x: 10, y: 20, w: 300, h: 200 },
        displayId: 1,
        sources: { microphone: true, systemAudio: true }
      }
    );
    await expect(pick).resolves.toMatchObject({
      ok: true,
      sources: { microphone: true, systemAudio: true }
    });
  });

  test("a commit without sources leaves the field absent", async () => {
    // Absent means "the selector did not ask", which is what routes the
    // recording entry point back to the persisted defaults. A `sources`
    // key holding undefined would defeat that.
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion();
    await vi.waitFor(() => expect(constructed[0]?.show).toHaveBeenCalled());

    emitSelectorResult(
      { ok: true, rect: { x: 10, y: 20, w: 300, h: 200 }, displayId: 1 }
    );
    const result = await pick;
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("sources");
  });

  test.each([
    ["a half-filled object", { microphone: true }],
    ["a non-boolean member", { microphone: true, systemAudio: "yes" }],
    ["null", null],
    ["a bare boolean", true]
  ])("rejects the whole commit when sources is %s", async (_label, sources) => {
    // A partially-parsed `sources` would read as "the user answered"
    // while defaulting the missing half to off — a recording quietly
    // missing audio the user armed. An unparseable payload is a cancel,
    // the same as a bad `action`.
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ intent: "video" });
    await vi.waitFor(() => expect(constructed[0]?.show).toHaveBeenCalled());

    emitSelectorResult(
      { ok: true, rect: { x: 10, y: 20, w: 300, h: 200 }, displayId: 1, sources }
    );
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });
});


describe("region-selector — invocation ownership during preparation", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test.each(["old-first", "new-first"])("supersedes a preparing capture immediately and retains the newest snapshot (%s)", async (order) => {
    const oldFrame = deferred<ScreenSnapshot>();
    const newFrame = deferred<ScreenSnapshot>();
    screenSnapshotMocks.captureAndRegister.mockReturnValueOnce(oldFrame.promise).mockReturnValueOnce(newFrame.promise);
    const { pickRegion } = await import("../capture/region-selector");
    const oldSettled = vi.fn();
    const oldPick = pickRegion({ keepPwrSnapChrome: true }).then(oldSettled);
    await flushSelector();
    expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledTimes(1);
    const newSettled = vi.fn();
    const newPick = pickRegion({ keepPwrSnapChrome: true }).then(newSettled);
    await flushSelector();
    expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledTimes(2);
    expect(oldSettled).toHaveBeenCalledWith(expect.objectContaining({ ok: false, reason: "cancelled" }));
    if (order === "old-first") {
      oldFrame.resolve(snapshot("old"));
      await flushSelector();
      expect(constructed[0]!.show).not.toHaveBeenCalled();
    }
    newFrame.resolve(snapshot("new"));
    await flushSelector();
    expect(constructed[0]!.show).toHaveBeenCalledTimes(1);
    if (order === "new-first") {
      oldFrame.resolve(snapshot("old"));
      await flushSelector();
    }
    expect(constructed[0]!.show).toHaveBeenCalledTimes(1);
    expect(latestMode()?.screenUrl).toBe("pwrsnap-screen://r/new");
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledExactlyOnceWith("old");
    expect(selectorShortcutMocks.callbacks.has("Escape")).toBe(true);
    emitSelectorResult({ ok: true, displayId: 1, rect: { x: 10, y: 20, w: 30, h: 40 } });
    await flushSelector();
    expect(newSettled).toHaveBeenCalledWith(expect.objectContaining({ ok: true, screenSnapshotId: "new" }));
    expect(screenSnapshotMocks.releaseSnapshot).not.toHaveBeenCalledWith("new");
    await Promise.all([oldPick, newPick]);
  });

  test.each(["hide", "dispose"])("%s settles a pending snapshot immediately and its late completion cannot reopen the selector", async (action) => {
    const frame = deferred<ScreenSnapshot>();
    screenSnapshotMocks.captureAndRegister.mockReturnValueOnce(frame.promise);
    const { pickRegion, hideSelector, disposeRegionSelector } = await import("../capture/region-selector");
    const settled = vi.fn();
    const pick = pickRegion({ keepPwrSnapChrome: true }).then(settled);
    await flushSelector();
    if (action === "hide") hideSelector(); else disposeRegionSelector();
    await flushSelector();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false, reason: action === "hide" ? "cancelled" : "destroyed" }));
    frame.resolve(snapshot("late"));
    await flushSelector();
    expect(constructed[0]!.show).not.toHaveBeenCalled();
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledExactlyOnceWith("late");
    await pick;
  });

  test("reserves ownership before window loading and suppresses superseded preparation", async () => {
    deferSelectorLoads = true;
    const { pickRegion } = await import("../capture/region-selector");
    const settled = vi.fn();
    const oldPick = pickRegion({ keepPwrSnapChrome: true }).then(settled);
    const newPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ reason: "cancelled" }));
    deferredLoadResolvers[0]!();
    await flushSelector();
    expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledTimes(1);
    emitSelectorResult({ ok: false });
    await Promise.all([oldPick, newPick]);
  });

  test.each(["hide", "dispose"])("%s while loading settles immediately and prevents capture after the load completes", async (action) => {
    deferSelectorLoads = true;
    const { pickRegion, hideSelector, disposeRegionSelector } = await import("../capture/region-selector");
    const settled = vi.fn();
    const pick = pickRegion({ keepPwrSnapChrome: true }).then(settled);
    if (action === "hide") hideSelector(); else disposeRegionSelector();
    await flushSelector();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ reason: action === "hide" ? "cancelled" : "destroyed" }));
    deferredLoadResolvers[0]!();
    await flushSelector();
    expect(screenSnapshotMocks.captureAndRegister).not.toHaveBeenCalled();
    expect(constructed[0]!.show).not.toHaveBeenCalled();
    await pick;
  });

  test("cancellation during the chrome flush lifts protection and never starts a snapshot", async () => {
    const setContentProtection = vi.fn();
    protectedWindows.set(99, { isDestroyed: () => false, setContentProtection, getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) });
    const { pickRegion, hideSelector } = await import("../capture/region-selector");
    const settled = vi.fn();
    const pick = pickRegion({ protectWindowIds: [99] }).then(settled);
    await flushSelector();
    expect(setContentProtection).toHaveBeenLastCalledWith(true);
    hideSelector();
    await flushSelector();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ reason: "cancelled" }));
    expect(setContentProtection).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(screenSnapshotMocks.captureAndRegister).not.toHaveBeenCalled();
    await pick;
  });

  test("old snapshot completion cannot lift a successor's content protection", async () => {
    const oldFrame = deferred<ScreenSnapshot>();
    const newFrame = deferred<ScreenSnapshot>();
    screenSnapshotMocks.captureAndRegister.mockReturnValueOnce(oldFrame.promise).mockReturnValueOnce(newFrame.promise);
    const setContentProtection = vi.fn();
    protectedWindows.set(99, { isDestroyed: () => false, setContentProtection, getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) });
    const { pickRegion } = await import("../capture/region-selector");
    const oldPick = pickRegion({ keepPwrSnapChrome: true, protectWindowIds: [99] });
    await vi.advanceTimersByTimeAsync(50);
    const newPick = pickRegion({ keepPwrSnapChrome: true, protectWindowIds: [99] });
    await vi.advanceTimersByTimeAsync(50);
    setContentProtection.mockClear();
    oldFrame.resolve(snapshot("old"));
    await flushSelector();
    expect(setContentProtection).not.toHaveBeenCalled();
    newFrame.resolve(snapshot("new"));
    await flushSelector();
    expect(setContentProtection).toHaveBeenCalledExactlyOnceWith(false);
    emitSelectorResult({ ok: false });
    await Promise.all([oldPick, newPick]);
  });

  test("rejects stale results, wrong senders and wrong displays without releasing the latest snapshot", async () => {
    suppressPaintAck = true;
    screenSnapshotMocks.captureAndRegister.mockResolvedValueOnce(snapshot("old")).mockResolvedValueOnce(snapshot("new"));
    const { pickRegion } = await import("../capture/region-selector");
    const oldPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    const newSettled = vi.fn();
    const newPick = pickRegion({ keepPwrSnapChrome: true }).then(newSettled);
    await flushSelector();
    const listener = ipcListeners.get("region-selector:result")!;
    const payload = { ok: true, displayId: 1, rect: { x: 10, y: 20, w: 30, h: 40 } };
    listener(selectorEvent(), { ...payload, screenUrl: "pwrsnap-screen://r/old" });
    listener({ ...selectorEvent(), sender: { ...selectorEvent().sender, id: 9999 } }, { ...payload, screenUrl: "pwrsnap-screen://r/new" });
    listener({ ...selectorEvent(), senderFrame: { processId: 10, routingId: 21 } }, { ...payload, screenUrl: "pwrsnap-screen://r/new" });
    emitSelectorResult({ ...payload, displayId: 2 });
    await flushSelector();
    expect(newSettled).not.toHaveBeenCalled();
    expect(screenSnapshotMocks.releaseSnapshot).not.toHaveBeenCalledWith("new");
    emitSelectorResult({ ok: false });
    await flushSelector();
    expect(newSettled).toHaveBeenCalledWith(expect.objectContaining({ reason: "cancelled" }));
    await Promise.all([oldPick, newPick]);
  });

  test("a stale raw read failure cannot abort the newer invocation using the same renderer", async () => {
    suppressPaintAck = true;
    const mapped = { ...snapshot("old"), selectorDescriptor: { id: "old", transport: "raw-rgba", version: 1, width: 2, height: 1, stride: 8, pixelFormat: 1, byteLength: 8 } };
    screenSnapshotMocks.captureAndRegister.mockResolvedValueOnce(mapped).mockResolvedValueOnce(snapshot("new"));
    const read = deferred<{ ok: false; code: "read_failed" }>();
    screenSnapshotMocks.readSnapshotForRenderer.mockReturnValueOnce(read.promise);
    const { pickRegion } = await import("../capture/region-selector");
    const oldPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    const pendingRead = ipcHandlers.get("region-selector:snapshot-read")!(selectorEvent(), { id: "old" });
    const settled = vi.fn();
    const newPick = pickRegion({ keepPwrSnapChrome: true }).then(settled);
    await flushSelector();
    read.resolve({ ok: false, code: "read_failed" });
    await pendingRead;
    await flushSelector();
    expect(settled).not.toHaveBeenCalled();
    expect(screenSnapshotMocks.releaseSnapshot).not.toHaveBeenCalledWith("new");
    emitSelectorResult({ ok: false });
    await Promise.all([oldPick, newPick]);
  });

  test.each(["preparing", "selecting"])("old token cleanup cannot cancel a %s successor; explicit cancellation still works", async (phase) => {
    const { pickRegion, hideSelector, isSelectorInvocationCurrent } = await import("../capture/region-selector");
    const oldPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    emitSelectorResult({ ok: false });
    const oldResult = await oldPick;
    expect(isSelectorInvocationCurrent(oldResult.selectorInvocationId)).toBe(true);
    const frame = deferred<ScreenSnapshot>();
    if (phase === "preparing") screenSnapshotMocks.captureAndRegister.mockReturnValueOnce(frame.promise);
    const settled = vi.fn();
    const newPick = pickRegion({ keepPwrSnapChrome: true }).then(settled);
    await flushSelector();
    expect(oldResult).toHaveProperty("selectorInvocationId");
    expect(isSelectorInvocationCurrent(oldResult.selectorInvocationId)).toBe(false);
    const hideCount = constructed[0]!.hide.mock.calls.length;
    setTimeout(() => hideSelector(oldResult.selectorInvocationId), 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(constructed[0]!.hide).toHaveBeenCalledTimes(hideCount);
    expect(settled).not.toHaveBeenCalled();
    expect(selectorShortcutMocks.callbacks.has("Escape")).toBe(phase === "selecting");
    hideSelector();
    await flushSelector();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ reason: "cancelled" }));
    frame.resolve(snapshot("cancelled-successor"));
    await flushSelector();
    await newPick;
  });

  test("a stale paint ack cannot reveal the successor or release its gate", async () => {
    suppressPaintAck = true;
    screenSnapshotMocks.captureAndRegister.mockResolvedValueOnce(snapshot("old")).mockResolvedValueOnce(snapshot("new"));
    const { pickRegion } = await import("../capture/region-selector");
    const oldPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    const newPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    ipcListeners.get("region-selector:painted")!(selectorEvent(), { screenUrl: "pwrsnap-screen://r/old" });
    await flushSelector();
    expect(constructed[0]!.show).not.toHaveBeenCalled();
    ipcListeners.get("region-selector:painted")!(selectorEvent(), { screenUrl: "pwrsnap-screen://r/new" });
    await flushSelector();
    expect(constructed[0]!.show).toHaveBeenCalledTimes(1);
    emitSelectorResult({ ok: false });
    await Promise.all([oldPick, newPick]);
  });

  test("late enumeration cannot replace the successor's provenance or send its window list", async () => {
    suppressPaintAck = true;
    const { listWindowsSnapshot } = await import("../capture/window-list");
    const oldLayout = deferred<Awaited<ReturnType<typeof listWindowsSnapshot>>>();
    const makeLayout = (pid: number) => ({
      windows: [{ windowId: pid, pid, bundleId: `example.app${pid}`, appName: "Fixture", title: "Fixture", bounds: { x: 10, y: 20, width: 300, height: 200 }, layer: 0, alpha: 1, isFrontmostInApp: true }],
      frontmostPid: pid, frontmostBundleId: `example.app${pid}`
    });
    vi.mocked(listWindowsSnapshot).mockReturnValueOnce(oldLayout.promise).mockResolvedValueOnce(makeLayout(222));
    screenSnapshotMocks.captureAndRegister.mockResolvedValueOnce(snapshot("old")).mockResolvedValueOnce(snapshot("new"));
    const { pickRegion, getLastWindowListSnapshot } = await import("../capture/region-selector");
    const oldPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    const newPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    oldLayout.resolve(makeLayout(111));
    await flushSelector();
    expect(getLastWindowListSnapshot().map(({ pid }) => pid)).toEqual([222]);
    ipcListeners.get("region-selector:painted")!(selectorEvent(), { screenUrl: "pwrsnap-screen://r/new" });
    await flushSelector();
    const lists = activeSelectorWindow().webContents.send.mock.calls.filter(([channel]) => channel === "region-selector:window-list");
    expect(lists).toHaveLength(1);
    expect(lists[0]![1].windows.map(({ pid }: { pid: number }) => pid)).toEqual([222]);
    emitSelectorResult({ ok: true, displayId: 1, rect: { x: 10, y: 20, w: 30, h: 40 } });
    await expect(newPick).resolves.toMatchObject({ ok: true, previousAppPid: 222, screenSnapshotId: "new" });
    await oldPick;
  });

  test("a committed result carries its own window provenance across a newer invocation and disposal", async () => {
    const { listWindowsSnapshot } = await import("../capture/window-list");
    const makeLayout = (pid: number) => ({
      windows: [{ windowId: 42, pid, bundleId: `example.app${pid}`, appName: `Fixture ${pid}`, title: "Fixture", bounds: { x: 10, y: 20, width: 300, height: 200 }, layer: 0, alpha: 1, isFrontmostInApp: true }],
      frontmostPid: pid, frontmostBundleId: `example.app${pid}`
    });
    vi.mocked(listWindowsSnapshot).mockResolvedValueOnce(makeLayout(111)).mockResolvedValueOnce(makeLayout(222));
    const { pickRegion, disposeRegionSelector, getLastWindowListSnapshot } = await import("../capture/region-selector");
    const firstPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    emitSelectorResult({ ok: true, displayId: 1, snappedWindowId: 42, rect: { x: 10, y: 20, w: 30, h: 40 } });
    const committed = await firstPick;
    const newerPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    expect(getLastWindowListSnapshot().map(({ pid }) => pid)).toEqual([222]);
    disposeRegionSelector();
    await newerPick;
    expect(committed).toHaveProperty("windowListSnapshot", makeLayout(111).windows);
  });

  test.each(["result-first", "dispose-first"])("the first terminal event wins and transferred snapshots remain consumer-owned (%s)", async (order) => {
    const { pickRegion, disposeRegionSelector } = await import("../capture/region-selector");
    const settled = vi.fn();
    const pick = pickRegion({ keepPwrSnapChrome: true }).then(settled);
    await flushSelector();
    const win = activeSelectorWindow();
    const resultListener = ipcListeners.get("region-selector:result")!;
    const result = { ok: true, displayId: 1, screenUrl: latestMode(win)!.screenUrl, rect: { x: 10, y: 20, w: 30, h: 40 } };
    if (order === "result-first") {
      resultListener(selectorEvent(win), result);
      disposeRegionSelector();
    } else {
      disposeRegionSelector();
      resultListener(selectorEvent(win), result);
    }
    await flushSelector();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining(order === "result-first" ? { ok: true } : { ok: false, reason: "destroyed" }));
    if (order === "result-first") expect(screenSnapshotMocks.releaseSnapshot).not.toHaveBeenCalled();
    else expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledExactlyOnceWith("snapshot-1");
    expect(screenSnapshotMocks.releaseAllSnapshots).not.toHaveBeenCalled();
    await pick;
  });

  test("snapshot rejection after supersession cannot cancel the successor, and a failed latest capture can be retried", async () => {
    const oldFrame = deferred<ScreenSnapshot>();
    screenSnapshotMocks.captureAndRegister.mockReturnValueOnce(oldFrame.promise).mockRejectedValueOnce(new Error("capture failed")).mockResolvedValueOnce(snapshot("retry"));
    const { pickRegion } = await import("../capture/region-selector");
    const oldPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    const failedPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    await expect(failedPick).resolves.toMatchObject({ reason: "destroyed" });
    const retryPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    oldFrame.reject(new Error("stale failure"));
    await flushSelector();
    expect(latestMode()!.screenUrl).toBe("pwrsnap-screen://r/retry");
    expect(selectorShortcutMocks.callbacks.has("Escape")).toBe(true);
    emitSelectorResult({ ok: false });
    await Promise.all([oldPick, retryPick]);
  });

  test("initial load navigation is allowed, but renderer loss while preparing cancels immediately", async () => {
    deferSelectorLoads = true;
    const frame = deferred<ScreenSnapshot>();
    screenSnapshotMocks.captureAndRegister.mockReturnValueOnce(frame.promise);
    const { pickRegion } = await import("../capture/region-selector");
    const settled = vi.fn();
    const pick = pickRegion({ keepPwrSnapChrome: true }).then(settled);
    const win = constructed[0]!;
    const navigate = win.webContents.on.mock.calls.find(([event]) => event === "did-start-navigation")![1];
    navigate({}, "file:///selector", false, true);
    await flushSelector();
    expect(settled).not.toHaveBeenCalled();
    deferredLoadResolvers[0]!();
    await flushSelector();
    expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledTimes(1);
    const gone = win.webContents.on.mock.calls.find(([event]) => event === "render-process-gone")![1];
    gone();
    await flushSelector();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ reason: "destroyed" }));
    frame.resolve(snapshot("orphan"));
    await flushSelector();
    expect(win.show).not.toHaveBeenCalled();
    expect(screenSnapshotMocks.releaseSnapshot).toHaveBeenCalledExactlyOnceWith("orphan");
    await pick;
  });

  test("dispose invalidates queued standby warmup and stale preparation across a restart", async () => {
    const frame = deferred<ScreenSnapshot>();
    screenSnapshotMocks.captureAndRegister.mockReturnValueOnce(frame.promise).mockResolvedValueOnce(snapshot("new"));
    const { pickRegion, disposeRegionSelector } = await import("../capture/region-selector");
    const oldPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    disposeRegionSelector();
    const newPick = pickRegion({ keepPwrSnapChrome: true });
    await flushSelector();
    frame.resolve(snapshot("old"));
    await flushSelector();
    expect(latestMode(constructed[1]!)?.screenUrl).toBe("pwrsnap-screen://r/new");
    expect(constructed[0]!.show).not.toHaveBeenCalled();
    emitSelectorResult({ ok: false }, constructed[1]!);
    await Promise.all([oldPick, newPick]);
    disposeRegionSelector();
    const count = constructed.length;
    await vi.runAllTimersAsync();
    expect(constructed).toHaveLength(count);
  });
});
