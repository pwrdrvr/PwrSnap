// Two surfaces read this store and neither can ask the DOM: the Linux caption
// glyph and the `#root::after` hairline that stands in for the border Electron
// gives a frameless Linux window none of. What is worth pinning is that it
// starts on Linux and only on Linux, that the attribute the stylesheet matches
// is stamped before the first paint, and that main's pushes reach it.

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  __resetWindowFrameForTests,
  isWindowMaximized,
  startWindowFrameSync,
  subscribeWindowFrame
} from "../window-frame";

type Handler = (payload: unknown) => void;

function installApi(
  platform: string,
  initial: { maximized: boolean } | null,
  read: () => Promise<{ maximized: boolean } | null> = () => Promise.resolve(initial)
) {
  const handlers = new Map<string, Handler>();
  const api = {
    platform,
    readWindowFrameState: vi.fn(read),
    on: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    })
  };
  (window as unknown as { pwrsnapApi: unknown }).pwrsnapApi = api;
  return { api, handlers };
}

afterEach(() => {
  __resetWindowFrameForTests();
  delete (window as unknown as { pwrsnapApi?: unknown }).pwrsnapApi;
});

describe("startWindowFrameSync", () => {
  test("stamps `restored` synchronously so the edge paints on the first frame", () => {
    installApi("linux", null);
    startWindowFrameSync();
    // Not awaited: the attribute has to be there before the IPC round trip
    // resolves, or the hairline appears a frame late on every launch.
    expect(document.documentElement.dataset["windowFrame"]).toBe("restored");
  });

  test("adopts the window's real state from the initial read", async () => {
    const { api } = installApi("linux", { maximized: true });
    startWindowFrameSync();
    await vi.waitFor(() => expect(isWindowMaximized()).toBe(true));
    expect(api.readWindowFrameState).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset["windowFrame"]).toBe("maximized");
  });

  test("follows main's pushes and notifies subscribers", async () => {
    const { handlers } = installApi("linux", { maximized: false });
    startWindowFrameSync();
    const seen: boolean[] = [];
    subscribeWindowFrame(() => seen.push(isWindowMaximized()));

    const push = handlers.get("events:window:frame-state");
    expect(push, "no subscription to the frame-state channel").toBeDefined();

    push?.({ maximized: true });
    expect(seen).toEqual([true]);
    expect(document.documentElement.dataset["windowFrame"]).toBe("maximized");

    // Idempotent: a repeat of the state we already hold wakes nobody. The WM
    // can fire `maximize` on a window that is already maximized.
    push?.({ maximized: true });
    expect(seen).toEqual([true]);

    push?.({ maximized: false });
    expect(seen).toEqual([true, false]);
    expect(document.documentElement.dataset["windowFrame"]).toBe("restored");
  });

  test("a push that lands mid-read wins over the read it raced", async () => {
    // Super+Up during the initial round trip. The read was issued before the
    // window was maximized, so its answer is already wrong when it arrives —
    // taking it would draw a Maximize glyph and a painted edge on a maximized
    // window, and leave them wrong until the next WM event.
    let resolveRead: (state: { maximized: boolean } | null) => void = () => undefined;
    const { handlers } = installApi(
      "linux",
      null,
      () => new Promise((resolve) => (resolveRead = resolve))
    );
    startWindowFrameSync();

    handlers.get("events:window:frame-state")?.({ maximized: true });
    expect(isWindowMaximized()).toBe(true);

    resolveRead({ maximized: false });
    await vi.waitFor(() => expect(isWindowMaximized()).toBe(true));
    expect(document.documentElement.dataset["windowFrame"]).toBe("maximized");
  });

  test("does nothing off Linux — no attribute, no IPC", () => {
    for (const platform of ["darwin", "win32"]) {
      const { api } = installApi(platform, { maximized: true });
      startWindowFrameSync();
      // macOS and Windows would be paying a per-window IPC round trip to feed
      // a CSS rule that cannot match.
      expect(api.readWindowFrameState, platform).not.toHaveBeenCalled();
      expect(api.on, platform).not.toHaveBeenCalled();
      expect(document.documentElement.dataset["windowFrame"], platform).toBeUndefined();
      __resetWindowFrameForTests();
    }
  });

  test("starts once per window even if called again", () => {
    const { api } = installApi("linux", { maximized: false });
    startWindowFrameSync();
    startWindowFrameSync();
    expect(api.readWindowFrameState).toHaveBeenCalledTimes(1);
    expect(api.on).toHaveBeenCalledTimes(1);
  });
});
