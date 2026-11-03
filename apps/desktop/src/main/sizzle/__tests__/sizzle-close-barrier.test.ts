import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { ElectronQuitModel } from "../../__tests__/electron-quit-model";
import {
  completeSizzleCloseRequest,
  installSizzleQuitBarrier,
  isSizzleQuitDeferred,
  markSizzleCloseRendererReady,
  wireSizzleCloseBarrier
} from "../sizzle-close-barrier";

type CloseEvent = { preventDefault: ReturnType<typeof vi.fn> };

function makeWindow(id: number): {
  window: BrowserWindow;
  send: ReturnType<typeof vi.fn>;
  close: () => void;
  destroy: () => void;
  lastCloseEvent: () => CloseEvent;
  isDestroyed: () => boolean;
  emitWebContents: (event: string) => void;
} {
  const listeners = new Map<string, Array<(event: CloseEvent) => void>>();
  const webContentsListeners = new Map<string, Array<() => void>>();
  const send = vi.fn();
  let destroyed = false;
  let latestEvent: CloseEvent = { preventDefault: vi.fn() };
  const fake = {
    id,
    isDestroyed: vi.fn(() => destroyed),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send,
      on: vi.fn((event: string, listener: () => void) => {
        const eventListeners = webContentsListeners.get(event) ?? [];
        eventListeners.push(listener);
        webContentsListeners.set(event, eventListeners);
      })
    },
    on: vi.fn((event: string, listener: (closeEvent: CloseEvent) => void) => {
      const eventListeners = listeners.get(event) ?? [];
      eventListeners.push(listener);
      listeners.set(event, eventListeners);
      return fake;
    }),
    close: vi.fn(() => {
      latestEvent = { preventDefault: vi.fn() };
      for (const listener of listeners.get("close") ?? []) listener(latestEvent);
      if (latestEvent.preventDefault.mock.calls.length === 0) {
        destroyed = true;
        for (const listener of listeners.get("closed") ?? []) listener(latestEvent);
      }
    })
  };
  return {
    window: fake as unknown as BrowserWindow,
    send,
    close: fake.close,
    destroy: () => {
      destroyed = true;
      for (const listener of listeners.get("closed") ?? []) listener(latestEvent);
    },
    lastCloseEvent: () => latestEvent,
    isDestroyed: () => destroyed,
    emitWebContents: (event) => {
      for (const listener of webContentsListeners.get(event) ?? []) listener();
    }
  };
}

describe("Sizzle close barrier", () => {
  test("blocks native close until the matching renderer response closes or cancels", () => {
    const fake = makeWindow(41);
    wireSizzleCloseBarrier(fake.window);
    expect(markSizzleCloseRendererReady(41)).toBe(true);

    fake.close();
    expect(fake.lastCloseEvent().preventDefault).toHaveBeenCalledOnce();
    expect(fake.send).toHaveBeenCalledWith(EVENT_CHANNELS.sizzleCloseRequested, {
      requestId: 1
    });
    expect(fake.isDestroyed()).toBe(false);

    // A second native close while the first request is pending stays blocked
    // and does not start a duplicate flush in the renderer.
    fake.close();
    expect(fake.lastCloseEvent().preventDefault).toHaveBeenCalledOnce();
    expect(fake.send).toHaveBeenCalledOnce();

    expect(completeSizzleCloseRequest(41, 1, "cancel")).toBe(true);
    expect(fake.isDestroyed()).toBe(false);

    fake.close();
    expect(fake.send).toHaveBeenLastCalledWith(EVENT_CHANNELS.sizzleCloseRequested, {
      requestId: 2
    });
    expect(completeSizzleCloseRequest(41, 1, "close")).toBe(false);
    expect(completeSizzleCloseRequest(41, 2, "close")).toBe(true);
    expect(fake.lastCloseEvent().preventDefault).not.toHaveBeenCalled();
    expect(fake.isDestroyed()).toBe(true);
  });

  test("queues an early or reloading-window close until the renderer listener is ready", () => {
    const fake = makeWindow(42);
    wireSizzleCloseBarrier(fake.window);

    fake.close();
    expect(fake.lastCloseEvent().preventDefault).toHaveBeenCalledOnce();
    expect(fake.send).not.toHaveBeenCalled();

    expect(markSizzleCloseRendererReady(42)).toBe(true);
    expect(fake.send).toHaveBeenCalledWith(EVENT_CHANNELS.sizzleCloseRequested, {
      requestId: 1
    });

    fake.emitWebContents("did-start-loading");
    expect(markSizzleCloseRendererReady(42)).toBe(true);
    expect(fake.send).toHaveBeenCalledTimes(2);
    expect(fake.send).toHaveBeenLastCalledWith(EVENT_CHANNELS.sizzleCloseRequested, {
      requestId: 1
    });

    expect(completeSizzleCloseRequest(42, 1, "cancel")).toBe(true);
    fake.close();
    expect(completeSizzleCloseRequest(42, 2, "close")).toBe(true);
  });

  test("resumes app.quit after the deferred renderer save succeeds", async () => {
    const fake = makeWindow(43);
    wireSizzleCloseBarrier(fake.window);
    markSizzleCloseRendererReady(43);

    let beforeQuit: ((event: CloseEvent) => void) | null = null;
    const app = {
      on: vi.fn((_event: "before-quit", listener: (event: CloseEvent) => void) => {
        beforeQuit = listener;
      }),
      quit: vi.fn(() => {
        const event = { preventDefault: vi.fn() };
        beforeQuit!(event);
        if (event.preventDefault.mock.calls.length === 0) fake.close();
      })
    };
    installSizzleQuitBarrier(
      app as unknown as Parameters<typeof installSizzleQuitBarrier>[0]
    );

    app.quit();
    expect(isSizzleQuitDeferred()).toBe(true);
    expect(fake.send).toHaveBeenCalledWith(EVENT_CHANNELS.sizzleCloseRequested, {
      requestId: 1
    });
    expect(fake.isDestroyed()).toBe(false);

    expect(completeSizzleCloseRequest(43, 1, "close")).toBe(true);
    expect(app.quit).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(app.quit).toHaveBeenCalledTimes(2);
    expect(isSizzleQuitDeferred()).toBe(false);
    expect(fake.isDestroyed()).toBe(true);
  });
});

describe("Sizzle quit ownership", () => {
  let barrier: typeof import("../sizzle-close-barrier");
  beforeEach(async () => {
    vi.resetModules();
    barrier = await import("../sizzle-close-barrier");
  });
  afterEach(() => vi.useRealTimers());

  test("releases a deferred quit when its window is destroyed before the save response", async () => {
    vi.useFakeTimers();
    const fake = makeWindow(44);
    barrier.wireSizzleCloseBarrier(fake.window);
    barrier.markSizzleCloseRendererReady(44);
    let beforeQuit!: (event: CloseEvent) => void;
    const app = {
      on: vi.fn((_event: string, listener: typeof beforeQuit) => { beforeQuit = listener; }),
      quit: vi.fn()
    };
    barrier.installSizzleQuitBarrier(app as unknown as Parameters<typeof installSizzleQuitBarrier>[0]);
    beforeQuit({ preventDefault: vi.fn() });
    expect(barrier.isSizzleQuitDeferred()).toBe(true);

    fake.destroy();
    expect(barrier.isSizzleQuitDeferred()).toBe(false);
    expect(barrier.completeSizzleCloseRequest(44, 1, "close")).toBe(false);
    expect(app.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app.quit).toHaveBeenCalledOnce();
  });

  test("resumes a native quit when the save acknowledgement settles inside its dispatch", async () => {
    const model = new ElectronQuitModel(["sizzle"]);
    const fake = makeWindow(45);
    barrier.wireSizzleCloseBarrier(fake.window);
    barrier.markSizzleCloseRendererReady(45);
    barrier.installSizzleQuitBarrier(model as unknown as Parameters<typeof installSizzleQuitBarrier>[0]);
    fake.send.mockImplementation(() => {
      void Promise.resolve().then(() => barrier.completeSizzleCloseRequest(45, 1, "close"));
    });
    await model.quitFromNativeTask();
    await model.settle();
    expect(model.hasQuit).toBe(true);
    expect(model.emitted).not.toContain("window-all-closed");
    fake.destroy();
  });

  test("repeated quit and a cancelled save preserve the window and reject stale responses", () => {
    const fake = makeWindow(46);
    barrier.wireSizzleCloseBarrier(fake.window);
    barrier.markSizzleCloseRendererReady(46);
    let beforeQuit!: (event: CloseEvent) => void;
    const app = {
      on: vi.fn((_event: string, listener: typeof beforeQuit) => { beforeQuit = listener; }),
      quit: vi.fn()
    };
    barrier.installSizzleQuitBarrier(app as unknown as Parameters<typeof installSizzleQuitBarrier>[0]);
    const cancelled = vi.fn();
    const unsubscribe = barrier.onSizzleQuitCancelled(cancelled);
    beforeQuit({ preventDefault: vi.fn() });
    beforeQuit({ preventDefault: vi.fn() });
    expect(fake.send).toHaveBeenCalledOnce();
    expect(barrier.completeSizzleCloseRequest(46, 99, "cancel")).toBe(false);
    expect(cancelled).not.toHaveBeenCalled();
    expect(barrier.completeSizzleCloseRequest(46, 1, "cancel")).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(barrier.isSizzleQuitDeferred()).toBe(false);
    expect(app.quit).not.toHaveBeenCalled();
    expect(fake.isDestroyed()).toBe(false);
    beforeQuit({ preventDefault: vi.fn() });
    expect(fake.send).toHaveBeenLastCalledWith(EVENT_CHANNELS.sizzleCloseRequested, { requestId: 2 });
    expect(barrier.completeSizzleCloseRequest(46, 1, "close")).toBe(false);
    barrier.completeSizzleCloseRequest(46, 2, "cancel");
    unsubscribe();
    fake.destroy();
  });

  test("keeps a save queued across a renderer crash and reload until its ready handshake", () => {
    const fake = makeWindow(47);
    barrier.wireSizzleCloseBarrier(fake.window);
    barrier.markSizzleCloseRendererReady(47);
    fake.close();
    fake.emitWebContents("render-process-gone");
    fake.emitWebContents("did-start-loading");
    expect(fake.send).toHaveBeenCalledOnce();
    expect(fake.isDestroyed()).toBe(false);
    barrier.markSizzleCloseRendererReady(47);
    expect(fake.send).toHaveBeenLastCalledWith(EVENT_CHANNELS.sizzleCloseRequested, { requestId: 1 });
    expect(fake.send).toHaveBeenCalledTimes(2);
    barrier.completeSizzleCloseRequest(47, 1, "cancel");
    fake.destroy();
  });

  test("honors cancellation from a replacement window before a queued retry dispatches", async () => {
    vi.useFakeTimers();
    const first = makeWindow(48);
    const second = makeWindow(49);
    barrier.wireSizzleCloseBarrier(first.window);
    barrier.markSizzleCloseRendererReady(first.window.id);
    let beforeQuit!: (event: CloseEvent) => void;
    const app = {
      on: vi.fn((_event: string, listener: typeof beforeQuit) => { beforeQuit = listener; }),
      quit: vi.fn()
    };
    barrier.installSizzleQuitBarrier(app as unknown as Parameters<typeof installSizzleQuitBarrier>[0]);
    beforeQuit({ preventDefault: vi.fn() });
    barrier.completeSizzleCloseRequest(48, 1, "close");
    expect(app.quit).not.toHaveBeenCalled();
    // A destroyed window is replaced and another quit is cancelled before
    // the old save's deferred retry gets its macrotask.
    first.destroy();
    barrier.wireSizzleCloseBarrier(second.window);
    barrier.markSizzleCloseRendererReady(second.window.id);
    beforeQuit({ preventDefault: vi.fn() });
    barrier.completeSizzleCloseRequest(49, 1, "cancel");
    await vi.advanceTimersByTimeAsync(1);
    expect(app.quit).not.toHaveBeenCalled();
    expect(barrier.isSizzleQuitDeferred()).toBe(false);
    second.destroy();
  });
});
