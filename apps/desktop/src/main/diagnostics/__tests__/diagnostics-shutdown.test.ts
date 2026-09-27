/*!
 * Adapted from DiskHound diagnostics shutdown (huntharo/diskhound@3877cdd).
 *
 * MIT License
 *
 * Copyright (c) 2026 Thomas Zarebczan
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDiagnosticsShutdown } from "../diagnostics-shutdown";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

function fixture(stop: () => void | Promise<void>) {
  vi.useFakeTimers();
  const warn = vi.fn();
  const event = { preventDefault: vi.fn() };
  const resumedEvent = { preventDefault: vi.fn() };
  const resumeQuit = vi.fn(() => {
    expect(shutdown.beforeQuit(resumedEvent)).toBe(false);
  });
  const stopSpy = vi.fn(stop);
  const shutdown = createDiagnosticsShutdown({ stop: stopSpy, resumeQuit, warn });
  return { shutdown, stopSpy, resumeQuit, warn, event, resumedEvent };
}

describe("diagnostics shutdown", () => {
  it("leaves only five seconds of the recording barrier after a diagnostics timeout", async () => {
    const f = fixture(() => new Promise(() => {}));
    expect(f.shutdown.remainingQuitTime(15_000)).toBe(15_000);
    f.shutdown.beforeQuit(f.event);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.shutdown.remainingQuitTime(15_000)).toBe(5_000);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.shutdown.remainingQuitTime(15_000)).toBe(0);
  });

  it("shares a referenced deadline and one flush even when stop reenters quit", async () => {
    const f = fixture(() => {
      f.shutdown.beforeQuit(f.event);
      return new Promise(() => {});
    });
    const timeout = vi.spyOn(globalThis, "setTimeout");
    f.shutdown.beforeQuit(f.event);
    const flush = f.shutdown.flush();
    expect(f.shutdown.flush()).toBe(flush);
    const timer = timeout.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.stopSpy).toHaveBeenCalledOnce();
    expect(f.resumeQuit).toHaveBeenCalledOnce();
    timeout.mockRestore();
  });

  it("handles error formatting that throws without holding quit", async () => {
    const f = fixture(() => Promise.reject({ toString() { throw new Error("format"); } }));
    f.shutdown.beforeQuit(f.event);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.resumeQuit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds quit until the capture is flushed, then allows the reentrant quit", async () => {
    const capture = deferred();
    const f = fixture(() => capture.promise);
    expect(f.shutdown.beforeQuit(f.event)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.resumeQuit).not.toHaveBeenCalled();
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.event.preventDefault).toHaveBeenCalledOnce();
    expect(f.resumeQuit).toHaveBeenCalledOnce();
    expect(f.resumedEvent.preventDefault).not.toHaveBeenCalled();
    expect(f.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("repeated quits cannot restart the deadline or a stuck stop", async () => {
    const capture = deferred();
    const f = fixture(() => capture.promise);
    f.shutdown.beforeQuit(f.event);
    await vi.advanceTimersByTimeAsync(9_999);
    f.shutdown.beforeQuit(f.event);
    expect(f.resumeQuit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.stopSpy).toHaveBeenCalledOnce();
    expect(f.resumeQuit).toHaveBeenCalledOnce();
    expect(f.warn).toHaveBeenCalledWith("diagnostics shutdown exceeded 10000 ms; continuing quit");
    capture.resolve();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.resumeQuit).toHaveBeenCalledOnce();
    expect(f.warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["throw", "reject"])("allows quit when stop fails with %s", async (failure) => {
    const f = fixture(() => {
      if (failure === "throw") throw new Error("disk unavailable");
      return Promise.reject(new Error("disk unavailable"));
    });
    f.shutdown.beforeQuit(f.event);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.resumeQuit).toHaveBeenCalledOnce();
    expect(f.warn).toHaveBeenCalledWith("diagnostics shutdown failed: disk unavailable; continuing quit");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles a late rejection after the deadline without retrying quit", async () => {
    let reject!: (error: Error) => void;
    const f = fixture(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    f.shutdown.beforeQuit(f.event);
    await vi.advanceTimersByTimeAsync(10_000);
    reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.resumeQuit).toHaveBeenCalledOnce();
    expect(f.warn).toHaveBeenCalledOnce();
  });

  it("does not let a failing warning logger prevent exit", async () => {
    const f = fixture(() => new Promise(() => {}));
    f.warn.mockImplementation(() => { throw new Error("log disk unavailable"); });
    f.shutdown.beforeQuit(f.event);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.resumeQuit).toHaveBeenCalledOnce();
  });

  it.each([false, true])("lets an updater own quit after its flush (timeout: %s)", async (timeout) => {
    const capture = deferred();
    const f = fixture(() => capture.promise);
    const install = vi.fn(() => {
      expect(f.shutdown.beforeQuit(f.event)).toBe(false);
    });
    const flush = f.shutdown.quitAndInstall(install);
    expect(f.shutdown.quitAndInstall(install)).toBe(flush);
    await vi.advanceTimersByTimeAsync(1);
    expect(install).not.toHaveBeenCalled();
    if (!timeout) capture.resolve();
    await vi.advanceTimersByTimeAsync(timeout ? 9_999 : 0);
    expect(install).toHaveBeenCalledOnce();
    expect(f.resumeQuit).not.toHaveBeenCalled();
    expect(f.event.preventDefault).not.toHaveBeenCalled();
    expect(f.stopSpy).toHaveBeenCalledOnce();
  });

  it("shares the deadline when an update takes over a pending normal quit", async () => {
    const f = fixture(() => new Promise<void>(() => {}));
    f.shutdown.beforeQuit(f.event);
    await vi.advanceTimersByTimeAsync(5_000);
    const install = vi.fn(() => {
      expect(f.shutdown.beforeQuit(f.resumedEvent)).toBe(false);
    });
    void f.shutdown.quitAndInstall(install);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.resumeQuit).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledOnce();
    expect(f.stopSpy).toHaveBeenCalledOnce();
    expect(f.resumedEvent.preventDefault).not.toHaveBeenCalled();
  });

  it.each([false, true])("gives a later normal quit a fresh budget after install failure (flush timeout: %s)", async (timeout) => {
    const capture = deferred();
    const f = fixture(() => capture.promise);
    // Include takeover: the failed install must not resume the earlier quit.
    f.shutdown.beforeQuit(f.event);
    const install = f.shutdown.quitAndInstall(() => { throw new Error("install failed"); });
    const rejected = expect(install).rejects.toThrow("install failed");
    if (!timeout) capture.resolve();
    await vi.advanceTimersByTimeAsync(timeout ? 10_000 : 0);
    await rejected;
    expect(f.resumeQuit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.shutdown.beforeQuit(f.resumedEvent)).toBe(false);
    expect(f.shutdown.remainingQuitTime(15_000)).toBe(15_000);
    await vi.advanceTimersByTimeAsync(4_000);
    f.shutdown.beforeQuit(f.resumedEvent);
    // Repeated quits and a late flush completion cannot restart the budget.
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.shutdown.remainingQuitTime(15_000)).toBe(11_000);
    expect(f.stopSpy).toHaveBeenCalledOnce();
    expect(f.resumeQuit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives an install retry a fresh budget without flushing stopped diagnostics again", async () => {
    const f = fixture(() => undefined);
    await expect(f.shutdown.quitAndInstall(() => {
      throw new Error("install failed");
    })).rejects.toThrow("install failed");
    await vi.advanceTimersByTimeAsync(20_000);

    const retry = vi.fn(() => {
      expect(f.shutdown.beforeQuit(f.event)).toBe(false);
      expect(f.shutdown.remainingQuitTime(15_000)).toBe(15_000);
    });
    await f.shutdown.quitAndInstall(retry);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(f.shutdown.remainingQuitTime(15_000)).toBe(11_000);
    expect(retry).toHaveBeenCalledOnce();
    expect(f.stopSpy).toHaveBeenCalledOnce();
    expect(f.resumeQuit).not.toHaveBeenCalled();
  });
});
