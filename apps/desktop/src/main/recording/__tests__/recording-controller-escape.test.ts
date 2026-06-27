// The recording-controller HUD is a non-activating panel, so its
// renderer cannot reliably receive plain keydown events. Esc during
// the video lead-in is bridged through Electron's globalShortcut and
// then routed through the normal recording:cancel command.

import { beforeEach, describe, expect, test, vi } from "vitest";

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
  overlappingWindows: [] as WindowSpy[],
  createdWindows: [] as WindowSpy[]
}));
const originalPlatform = process.platform;

type WindowSpy = {
  isDestroyed: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setContentSize: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  getSize: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  moveTop: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

function makeWindowSpy(): WindowSpy {
  return {
    isDestroyed: vi.fn(() => false),
    setIgnoreMouseEvents: vi.fn(),
    setContentSize: vi.fn(),
    setPosition: vi.fn(),
    getSize: vi.fn(() => [420, 80]),
    isVisible: vi.fn(() => false),
    showInactive: vi.fn(),
    moveTop: vi.fn(),
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
  subscribeToRecordingState: vi.fn()
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
  mocks.overlappingWindows.length = 0;
  mocks.createdWindows.length = 0;
});

describe("recording-controller lead-in Escape shortcut", () => {
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
