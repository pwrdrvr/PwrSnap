import type { BrowserWindow } from "electron";
import { describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
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

  test("resumes app.quit after the deferred renderer save succeeds", () => {
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
    expect(app.quit).toHaveBeenCalledTimes(2);
    expect(isSizzleQuitDeferred()).toBe(false);
    expect(fake.isDestroyed()).toBe(true);
  });
});
