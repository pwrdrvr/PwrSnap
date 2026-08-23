// The recording-controller HUD is a non-activating panel, so its
// renderer cannot reliably receive plain keydown events. Esc during
// the video lead-in is bridged through Electron's globalShortcut and
// then routed through the normal recording:cancel command.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RecordingState } from "@pwrsnap/shared";

type ShortcutCallback = () => void;

const mocks = vi.hoisted(() => ({
  shortcutCallbacks: new Map<string, ShortcutCallback>(),
  registerShortcut: vi.fn((accelerator: string, callback: ShortcutCallback) => {
    mocks.shortcutCallbacks.set(accelerator, callback);
    return true;
  }),
  unregisterShortcut: vi.fn((accelerator: string) => {
    mocks.shortcutCallbacks.delete(accelerator);
  }),
  dispatch: vi.fn(async () => ({ ok: true, value: undefined })),
  setPermissionWindowId: vi.fn(),
  recordingState: { phase: "idle" } as RecordingState,
  overlappingWindows: [] as WindowSpy[],
  createdWindows: [] as WindowSpy[]
}));
const originalPlatform = process.platform;

type WindowSpy = {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setFocusable: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setContentSize: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  getSize: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  moveTop: ReturnType<typeof vi.fn>;
  blur: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

function makeWindowSpy(): WindowSpy {
  return {
    id: 71,
    isDestroyed: vi.fn(() => false),
    setAlwaysOnTop: vi.fn(),
    setFocusable: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setContentSize: vi.fn(),
    setPosition: vi.fn(),
    getSize: vi.fn(() => [420, 80]),
    isVisible: vi.fn(() => false),
    showInactive: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    moveTop: vi.fn(),
    blur: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn()
  };
}

vi.mock("electron", () => ({
  BrowserWindow: {},
  globalShortcut: {
    register: mocks.registerShortcut,
    unregister: mocks.unregisterShortcut
  },
  screen: {
    getAllDisplays: () => [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 0, width: 1440, height: 875 }
      }
    ],
    getPrimaryDisplay: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 0, width: 1440, height: 875 }
    })
  }
}));

vi.mock("../../command-bus", () => ({
  bus: {
    dispatch: mocks.dispatch
  }
}));

vi.mock("../../capture/rect-overlap", () => ({
  appWindowsOverlappingRect: () => mocks.overlappingWindows
}));

vi.mock("../../window", () => ({
  createRecordingControllerWindow: () => {
    const win = makeWindowSpy();
    mocks.createdWindows.push(win);
    return win;
  }
}));

vi.mock("../recording-state", () => ({
  getRecordingState: () => mocks.recordingState,
  subscribeToRecordingState: vi.fn()
}));

vi.mock("../recording-permission-preflight", () => ({
  setRecordingPermissionControllerWindowId: mocks.setPermissionWindowId
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  vi.resetModules();
  mocks.shortcutCallbacks.clear();
  mocks.registerShortcut.mockClear();
  mocks.unregisterShortcut.mockClear();
  mocks.dispatch.mockClear();
  mocks.setPermissionWindowId.mockClear();
  mocks.overlappingWindows.length = 0;
  mocks.createdWindows.length = 0;
  mocks.recordingState = { phase: "idle" };
});

describe("recording-controller lead-in Escape shortcut", () => {
  test("permission phase is focused and interactive, then countdown restores click-through", async () => {
    const { applyRecordingStateToController } = await import("../recording-controller");

    applyRecordingStateToController({
      phase: "permission",
      preflight: {
        requestId: "request-1",
        displayId: 1,
        capabilities: { microphone: true, systemAudio: false },
        missing: [{ permission: "microphone", status: "denied" }]
      }
    });

    const win = mocks.createdWindows[0];
    expect(mocks.setPermissionWindowId).toHaveBeenCalledWith(71);
    expect(win?.setAlwaysOnTop).toHaveBeenCalledWith(true, "floating");
    expect(win?.setFocusable).toHaveBeenCalledWith(true);
    expect(win?.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    expect(win?.setContentSize).toHaveBeenCalledWith(560, 640, false);
    expect(win?.show).toHaveBeenCalledTimes(1);
    expect(win?.focus).toHaveBeenCalledTimes(1);
    expect(
      win?.setAlwaysOnTop.mock.invocationCallOrder[0]
    ).toBeLessThan(win?.show.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.registerShortcut).not.toHaveBeenCalled();

    applyRecordingStateToController({
      phase: "countdown",
      sessionId: "rec-1",
      secondsRemaining: 3,
      rect: { x: 10, y: 20, w: 800, h: 600 },
      displayId: 1
    });
    expect(win?.setFocusable).toHaveBeenLastCalledWith(false);
    expect(win?.setAlwaysOnTop).toHaveBeenLastCalledWith(true, "floating");
    expect(win?.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
    expect(mocks.registerShortcut).toHaveBeenCalledWith("Escape", expect.any(Function));
  });

  test("Settings round-trip lowers before launch and permission republishes do not refocus", async () => {
    const { applyRecordingStateToController } = await import("../recording-controller");
    const base = {
      requestId: "request-settings",
      displayId: 1,
      capabilities: { microphone: true, systemAudio: false },
      missing: [{ permission: "microphone" as const, status: "denied" as const }]
    };
    applyRecordingStateToController({ phase: "permission", preflight: base });
    const win = mocks.createdWindows[0];
    win?.isVisible.mockReturnValue(true);
    win?.focus.mockClear();
    win?.moveTop.mockClear();
    win?.setAlwaysOnTop.mockClear();
    win?.blur.mockClear();

    const awaiting = { ...base, awaitingSettings: true as const };
    mocks.recordingState = { phase: "permission", preflight: awaiting };
    applyRecordingStateToController({ phase: "permission", preflight: awaiting });

    expect(win?.setAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(win?.blur).toHaveBeenCalledTimes(1);
    expect(win?.focus).not.toHaveBeenCalled();
    expect(win?.moveTop).not.toHaveBeenCalled();

    // openExternal returning may republish the same request, but it must not
    // steal focus or move above System Settings.
    applyRecordingStateToController({ phase: "permission", preflight: awaiting });
    expect(win?.focus).not.toHaveBeenCalled();
    expect(win?.moveTop).not.toHaveBeenCalled();

    // A genuine native focus event is the only automatic raise path.
    const focusListener = win?.on.mock.calls.find(([event]) => event === "focus")?.[1] as
      | (() => void)
      | undefined;
    focusListener?.();
    expect(win?.setAlwaysOnTop).toHaveBeenLastCalledWith(true, "floating");
    expect(win?.moveTop).toHaveBeenCalledTimes(1);
    expect(win?.focus).not.toHaveBeenCalled();
  });

  test("permission Cancel's idle transition destroys the controller renderer", async () => {
    const { applyRecordingStateToController } = await import("../recording-controller");
    applyRecordingStateToController({
      phase: "permission",
      preflight: {
        requestId: "request-1",
        displayId: 1,
        capabilities: { microphone: false, systemAudio: false },
        missing: [{ permission: "screen", status: "denied" }]
      }
    });
    const win = mocks.createdWindows[0];

    applyRecordingStateToController({ phase: "idle" });

    expect(win?.hide).toHaveBeenCalledTimes(1);
    expect(win?.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.setPermissionWindowId).toHaveBeenLastCalledWith(null);
  });

  test("permission content resize is request-bound and clamped to the display", async () => {
    const {
      applyRecordingStateToController,
      resizeRecordingPermissionController
    } = await import("../recording-controller");
    const state: RecordingState = {
      phase: "permission",
      preflight: {
        requestId: "request-size",
        displayId: 1,
        capabilities: { microphone: true, systemAudio: true },
        missing: [
          { permission: "microphone", status: "restricted" },
          { permission: "systemAudio", status: "unavailable" }
        ]
      }
    };
    mocks.recordingState = state;
    applyRecordingStateToController(state);
    const win = mocks.createdWindows[0];
    win?.setContentSize.mockClear();

    expect(
      resizeRecordingPermissionController({
        requestId: "stale",
        width: 560,
        height: 500
      })
    ).toBe(false);
    expect(
      resizeRecordingPermissionController({
        requestId: "request-size",
        width: 10,
        height: 5_000
      })
    ).toBe(true);
    expect(win?.setContentSize).toHaveBeenCalledWith(420, 843, false);
    expect(win?.setPosition).toHaveBeenLastCalledWith(510, 16, false);
  });

  test("Escape during countdown dispatches recording:cancel through the command bus", async () => {
    const { applyRecordingStateToController } = await import("../recording-controller");

    applyRecordingStateToController({
      phase: "countdown",
      sessionId: "rec-1",
      secondsRemaining: 3,
      rect: { x: 10, y: 20, w: 800, h: 600 },
      displayId: 1
    });

    expect(mocks.registerShortcut).toHaveBeenCalledWith("Escape", expect.any(Function));
    mocks.shortcutCallbacks.get("Escape")?.();

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "recording:cancel",
      {},
      { principal: "ipc" }
    );
  });

  test("leaving lead-in unregisters Escape so recording controls do not hijack the key", async () => {
    const { applyRecordingStateToController } = await import("../recording-controller");

    applyRecordingStateToController({
      phase: "countdown",
      sessionId: "rec-1",
      secondsRemaining: 1,
      rect: { x: 10, y: 20, w: 800, h: 600 },
      displayId: 1
    });
    applyRecordingStateToController({
      phase: "recording",
      sessionId: "rec-1",
      startedAt: new Date(0).toISOString(),
      rect: { x: 10, y: 20, w: 800, h: 600 },
      displayId: 1
    });

    expect(mocks.unregisterShortcut).toHaveBeenCalledWith("Escape");
    expect(mocks.shortcutCallbacks.has("Escape")).toBe(false);
  });

  test("full-display Windows recordings keep the HUD at the normal tray-stop position", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { applyRecordingStateToController } = await import("../recording-controller");

    applyRecordingStateToController({
      phase: "recording",
      sessionId: "rec-1",
      startedAt: new Date(0).toISOString(),
      rect: { x: 0, y: 0, w: 0, h: 0 },
      displayId: 1
    });

    const win = mocks.createdWindows[0];
    expect(win?.setPosition).toHaveBeenCalledWith(510, 16, false);
  });
});
