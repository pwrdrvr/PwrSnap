import { describe, expect, test, vi } from "vitest";
import {
  acquireFrozenDisplayFrame,
  FROZEN_DISPLAY_MEDIA_CONSTRAINTS,
  physicalCropRect,
  stopDisplayStream
} from "../frozen-frame";

test("requests a cursor-free display track", () => {
  expect(FROZEN_DISPLAY_MEDIA_CONSTRAINTS).toEqual({
    video: { cursor: "never" },
    audio: false
  });
});

describe("frozen frame coordinate mapping", () => {
  test("maps CSS selection to the actual physical frame dimensions", () => {
    expect(
      physicalCropRect(
        { x: 100, y: 50, w: 400, h: 200 },
        { width: 1440, height: 900 },
        { width: 2880, height: 1800 }
      )
    ).toEqual({ x: 200, y: 100, width: 800, height: 400 });
  });

  test("uses independent axes and clamps an overhanging window crop", () => {
    expect(
      physicalCropRect(
        { x: -20, y: 700, w: 400, h: 300 },
        { width: 1920, height: 1080 },
        { width: 2560, height: 1440 }
      )
    ).toEqual({ x: 0, y: 933, width: 507, height: 400 });
  });

  test("rejects a selection wholly outside or merely touching the frame", () => {
    expect(() =>
      physicalCropRect(
        { x: 1920, y: 10, w: 100, h: 100 },
        { width: 1920, height: 1080 },
        { width: 3840, height: 2160 }
      )
    ).toThrow("does not intersect");
  });

  test("preserves a one-pixel logical strip as a non-empty crop", () => {
    expect(
      physicalCropRect(
        { x: 20, y: 20, w: 200, h: 1 },
        { width: 1000, height: 500 },
        { width: 2000, height: 1000 }
      )
    ).toEqual({ x: 40, y: 40, width: 400, height: 2 });
  });
});

test("stops every display-media track", () => {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  stopDisplayStream({ getTracks: () => tracks } as never);
  expect(tracks[0]!.stop).toHaveBeenCalledTimes(1);
  expect(tracks[1]!.stop).toHaveBeenCalledTimes(1);
});

test("stops a display stream that resolves after the bounded acquisition timeout", async () => {
  vi.useFakeTimers();
  try {
    let resolveStream!: (stream: MediaStream) => void;
    const pendingStream = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    const acquire = acquireFrozenDisplayFrame({} as HTMLCanvasElement, () => pendingStream, 5);
    const rejection = expect(acquire).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5);
    await rejection;

    const stop = vi.fn();
    resolveStream({ getTracks: () => [{ stop }] } as never);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
