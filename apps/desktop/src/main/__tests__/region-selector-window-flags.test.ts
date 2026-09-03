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
  isSimpleFullScreen: ReturnType<typeof vi.fn>;
  setContentBounds: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  getBounds: ReturnType<typeof vi.fn>;
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

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });
});

describe("region-selector — mapped snapshot IPC boundary", () => {
  test("admits only the active selector top-level frame and active opaque id", async () => {
    screenSnapshotMocks.captureAndRegister.mockResolvedValueOnce({
      id: "mapped-snapshot-1",
      displayId: 1,
      transport: "windows-shared-memory",
      selectorDescriptor: {
        id: "mapped-snapshot-1",
        transport: "windows-shared-memory",
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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
    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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
    expect(chromeMocks.setFloatOverState).toHaveBeenCalledWith({ kind: "cancel" });

    const hideOrder = chromeMocks.hideTrayPopoverIfVisible.mock.invocationCallOrder[0]!;
    const parkOrder = chromeMocks.setFloatOverState.mock.invocationCallOrder[0]!;
    const freezeOrder = screenSnapshotMocks.captureAndRegister.mock.invocationCallOrder[0]!;
    expect(hideOrder).toBeLessThan(freezeOrder);
    expect(parkOrder).toBeLessThan(freezeOrder);

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });

  test("timed mode keeps the tray up — the countdown exists to capture it", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(screenSnapshotMocks.captureAndRegister).toHaveBeenCalledTimes(1);
    });
    expect(chromeMocks.hideTrayPopoverIfVisible).not.toHaveBeenCalled();

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
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

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false });
  });

  test("a record commit carries the action through to the result", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ quickCaptureAction: "ask" });
    await vi.waitFor(() => expect(constructed[0]?.show).toHaveBeenCalled());

    ipcListeners.get("region-selector:result")?.(
      {},
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

    ipcListeners.get("region-selector:result")?.(
      {},
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

    ipcListeners.get("region-selector:result")?.(
      {},
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

    ipcListeners.get("region-selector:result")?.(
      {},
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

    ipcListeners.get("region-selector:result")?.(
      {},
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
