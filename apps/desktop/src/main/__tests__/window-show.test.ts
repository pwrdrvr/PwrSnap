// Tests for `showWindowWhenReady` — the three-layer fallback that
// covers Linux's flaky `ready-to-show` event (PwrAgnt parity).
//
// What MUST hold:
//   • Whichever signal fires first wins; the others are skipped.
//   • `onShow` runs EXACTLY ONCE on the winning signal.
//   • `window.show()` is called EXACTLY ONCE.
//   • Late signals are ignored (no double-show, no double-onShow).
//   • Pending timers are cleared on `closed` (no leaks if the window
//     dies before any signal fires).
//   • A destroyed window short-circuits the show entirely.
//
// Hand-rolled BrowserWindow / WebContents mocks — same pattern as
// window-content-protection.test.ts. Uses vi.useFakeTimers so the
// 100ms (did-finish-load buffer) and 1000ms (hard fallback) timers
// land deterministically.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { showWindowWhenReady } from "../window-show";

// Mock the logger so the test doesn't spew main-log lines into the
// vitest output.
vi.mock("../log", () => ({
  getMainLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

type Listener = () => void;

interface MockWebContents {
  once: ReturnType<typeof vi.fn>;
  __fire: (event: string) => void;
}

interface MockBrowserWindow {
  id: number;
  show: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  webContents: MockWebContents;
  __fire: (event: string) => void;
}

function makeMockWebContents(): MockWebContents {
  const listeners = new Map<string, Listener[]>();
  return {
    once: vi.fn((event: string, listener: Listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    }),
    __fire: (event: string) => {
      const list = listeners.get(event) ?? [];
      // `.once` semantics: fire the queued listeners then drop them so
      // a second `__fire("...")` is a no-op (matches Electron's once).
      listeners.set(event, []);
      for (const fn of list) fn();
    }
  };
}

function makeMockWindow(): MockBrowserWindow {
  const listeners = new Map<string, Listener[]>();
  const webContents = makeMockWebContents();
  return {
    id: 1,
    show: vi.fn(),
    isDestroyed: vi.fn(() => false),
    once: vi.fn((event: string, listener: Listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    }),
    webContents,
    __fire: (event: string) => {
      const list = listeners.get(event) ?? [];
      listeners.set(event, []);
      for (const fn of list) fn();
    }
  };
}

describe("showWindowWhenReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("ready-to-show wins → show + onShow called immediately, no fallback timers fire", () => {
    const window = makeMockWindow();
    const onShow = vi.fn();
    showWindowWhenReady(window as never, { label: "test", onShow });

    window.__fire("ready-to-show");

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledTimes(1);

    // Advance past both fallback windows; nothing more should fire.
    vi.advanceTimersByTime(2000);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  test("did-finish-load fallback (Linux A) — ready-to-show never fires", () => {
    const window = makeMockWindow();
    const onShow = vi.fn();
    showWindowWhenReady(window as never, { label: "test", onShow });

    // Simulate the Linux failure mode: ready-to-show never fires.
    window.webContents.__fire("did-finish-load");

    // Show is scheduled, NOT immediate — there's a 100ms buffer to let
    // the first frame paint before show().
    expect(window.show).not.toHaveBeenCalled();
    expect(onShow).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    expect(window.show).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledTimes(1);

    // Hard fallback at 1000ms should NOT also fire.
    vi.advanceTimersByTime(2000);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  test("hard fallback (Linux B) — neither ready-to-show nor did-finish-load fires", () => {
    const window = makeMockWindow();
    const onShow = vi.fn();
    showWindowWhenReady(window as never, { label: "test", onShow });

    vi.advanceTimersByTime(999);
    expect(window.show).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  test("late signals ignored after first show", () => {
    const window = makeMockWindow();
    const onShow = vi.fn();
    showWindowWhenReady(window as never, { label: "test", onShow });

    window.__fire("ready-to-show");
    expect(window.show).toHaveBeenCalledTimes(1);

    // Late did-finish-load + its 100ms buffer expiring should NOT
    // call show again.
    window.webContents.__fire("did-finish-load");
    vi.advanceTimersByTime(200);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledTimes(1);

    // Same for the hard fallback.
    vi.advanceTimersByTime(1000);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  test("destroyed window short-circuits show + onShow", () => {
    const window = makeMockWindow();
    const onShow = vi.fn();
    showWindowWhenReady(window as never, { label: "test", onShow });

    window.isDestroyed = vi.fn(() => true);
    window.__fire("ready-to-show");

    expect(window.show).not.toHaveBeenCalled();
    expect(onShow).not.toHaveBeenCalled();
  });

  test("close before any signal fires clears pending timers (no late show)", () => {
    const window = makeMockWindow();
    const onShow = vi.fn();
    showWindowWhenReady(window as never, { label: "test", onShow });

    // Close fires before any of the three signals.
    window.__fire("closed");

    // Advance past all fallback windows — nothing should fire because
    // the closed handler cleared the timers.
    vi.advanceTimersByTime(2000);
    expect(window.show).not.toHaveBeenCalled();
    expect(onShow).not.toHaveBeenCalled();
  });

  test("works without onShow callback (call site doesn't need to provide one)", () => {
    const window = makeMockWindow();
    showWindowWhenReady(window as never, { label: "test" });

    window.__fire("ready-to-show");

    expect(window.show).toHaveBeenCalledTimes(1);
    // No throw despite no onShow.
  });
});
