// The permission guide controller: one window however often it is asked for,
// the drag only for that window, close-on-grant, and nothing left running
// once it is gone.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

function emitter() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(event: string, fn: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    }
  };
}

function fakeWindow(id: number) {
  const win = emitter();
  const contents = emitter();
  let destroyed = false;
  let bounds = { x: 0, y: 0, width: 316, height: 380 };
  const webContents = {
    id,
    send: vi.fn(),
    startDrag: vi.fn(),
    on: contents.on,
    emit: contents.emit
  };
  return {
    webContents,
    on: win.on,
    isDestroyed: () => destroyed,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      win.emit("closed");
    },
    getBounds: () => bounds,
    setBounds: vi.fn((b: typeof bounds) => {
      bounds = b;
    }),
    showInactive: vi.fn()
  };
}

const h = vi.hoisted(() => ({
  windows: [] as Array<ReturnType<typeof fakeWindow>>,
  screen: "denied" as string,
  settingsOpen: true,
  listCalls: 0,
  openCalls: 0
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "/Applications/PwrSnap.app/Contents/MacOS/PwrSnap",
    getFileIcon: async () => ({ isEmpty: () => true })
  },
  nativeImage: {
    createThumbnailFromPath: async () => ({
      isEmpty: () => false,
      resize: () => ({ isEmpty: () => false }),
      toDataURL: () => "data:image/png;base64,AAAA"
    }),
    createEmpty: () => ({ isEmpty: () => true })
  },
  screen: {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 30, width: 1512, height: 920 } }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 30, width: 1512, height: 920 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 })
  }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({ debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined })
}));

vi.mock("../../window", () => ({
  createPermissionGuideWindow: vi.fn(() => {
    const win = fakeWindow(100 + h.windows.length);
    h.windows.push(win);
    return win;
  })
}));

vi.mock("../window-list", () => ({
  listWindowsSnapshot: vi.fn(async () => {
    h.listCalls += 1;
    return {
      windows: h.settingsOpen
        ? [{ bundleId: "com.apple.systempreferences", bounds: { x: 200, y: 120, width: 715, height: 600 } }]
        : [],
      frontmostPid: null,
      frontmostBundleId: null
    };
  })
}));

vi.mock("../../recording/recording-permissions", () => ({
  openSystemSettingsFor: vi.fn(async () => {
    h.openCalls += 1;
  }),
  readScreenStatus: () => h.screen
}));

const originalPlatform = process.platform;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "darwin" });
  h.windows = [];
  h.screen = "denied";
  h.settingsOpen = true;
  h.listCalls = 0;
  h.openCalls = 0;
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

async function load() {
  return import("../permission-guide");
}

describe("permission guide", () => {
  test("overlapping shows build ONE window", async () => {
    const guide = await load();
    await Promise.all([guide.showPermissionGuide(), guide.showPermissionGuide()]);
    expect(h.windows).toHaveLength(1);
    expect(h.openCalls).toBe(1);
    guide.closePermissionGuide();
  });

  test("a show while open refreshes the same window and re-opens Settings", async () => {
    const guide = await load();
    await guide.showPermissionGuide();
    await guide.showPermissionGuide();
    expect(h.windows).toHaveLength(1);
    expect(h.openCalls).toBe(2);
    guide.closePermissionGuide();
  });

  test("shows inactive, beside Settings, once polled and measured", async () => {
    const guide = await load();
    await guide.showPermissionGuide();
    guide.resizePermissionGuide(400);
    await vi.advanceTimersByTimeAsync(10);
    const win = h.windows[0]!;
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.getBounds().x).toBe(200 + 715 + 6);
    expect(guide.getPermissionGuideState()?.notch?.side).toBe("left");
    guide.closePermissionGuide();
  });

  test("granted → state says so, then the window closes itself", async () => {
    const guide = await load();
    await guide.showPermissionGuide();
    await vi.advanceTimersByTimeAsync(10);
    h.screen = "granted";
    await vi.advanceTimersByTimeAsync(600);
    expect(guide.getPermissionGuideState()?.phase).toBe("granted");
    await vi.advanceTimersByTimeAsync(2_600);
    expect(h.windows[0]!.isDestroyed()).toBe(true);
    expect(guide.getPermissionGuideState()).toBeNull();
  });

  test("Settings closing after being seen → settings-closed, and the poll slows", async () => {
    const guide = await load();
    await guide.showPermissionGuide();
    await vi.advanceTimersByTimeAsync(10);
    h.settingsOpen = false;
    await vi.advanceTimersByTimeAsync(1_600);
    expect(guide.getPermissionGuideState()?.phase).toBe("settings-closed");
    const before = h.listCalls;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.listCalls - before).toBeLessThanOrEqual(2);
    guide.closePermissionGuide();
  });

  test("the drag runs only for the guide's own WebContents, with the running bundle", async () => {
    const guide = await load();
    await guide.showPermissionGuide();
    const own = h.windows[0]!.webContents;
    const other = { id: 7, startDrag: vi.fn() };
    guide.startPermissionGuideDrag(other as never);
    expect(other.startDrag).not.toHaveBeenCalled();
    guide.startPermissionGuideDrag(own as never);
    expect(own.startDrag).toHaveBeenCalledWith(
      expect.objectContaining({ file: "/Applications/PwrSnap.app" })
    );
    guide.closePermissionGuide();
  });

  test("a crashed renderer closes the window and stops polling", async () => {
    const guide = await load();
    await guide.showPermissionGuide();
    await vi.advanceTimersByTimeAsync(10);
    h.windows[0]!.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(h.windows[0]!.isDestroyed()).toBe(true);
    const before = h.listCalls;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.listCalls).toBe(before);
  });

  test("a close and quick reopen does not inherit the old first-measure deadline", async () => {
    const guide = await load();
    await guide.showPermissionGuide();
    await vi.advanceTimersByTimeAsync(900);
    guide.closePermissionGuide();
    await guide.showPermissionGuide();
    // 400 ms in: the OLD deadline would have fired by now; the new one has not.
    await vi.advanceTimersByTimeAsync(400);
    expect(h.windows[1]!.showInactive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(h.windows[1]!.showInactive).toHaveBeenCalledTimes(1);
    guide.closePermissionGuide();
  });
});
