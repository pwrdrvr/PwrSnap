import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; payload: unknown }>
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            mocks.sent.push({ channel, payload });
          }
        }
      }
    ]
  }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.sent.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recording failure state", () => {
  test("is durable and broadcasts only the renderer-safe allowlisted shape", async () => {
    const {
      getRecordingState,
      setRecordingFailureState,
      subscribeToRecordingState
    } = await import("../recording-state");
    const subscriber = vi.fn();
    const unsubscribe = subscribeToRecordingState(subscriber);

    setRecordingFailureState({
      sessionId: "failed-session",
      code: "recorder_spawn_failed",
      canRetry: true,
      displayId: 7
    });

    const expected = {
      phase: "failed",
      sessionId: "failed-session",
      code: "recorder_spawn_failed",
      canRetry: true,
      displayId: 7
    } as const;
    expect(getRecordingState()).toEqual(expected);
    expect(subscriber).toHaveBeenLastCalledWith(expected);
    expect(mocks.sent.at(-1)?.payload).toEqual(expected);

    const serialized = JSON.stringify(getRecordingState());
    expect(serialized).not.toContain("message");
    expect(serialized).not.toContain("cause");
    expect(serialized).not.toContain("argv");
    expect(serialized).not.toContain("path");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getRecordingState()).toEqual(expected);
    expect(vi.getTimerCount()).toBe(0);

    unsubscribe();
  });
});
