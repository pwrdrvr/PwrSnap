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

test("freezes into a readable 2d canvas instead of a bitmaprenderer backing store", async () => {
  const readyStateDescriptor = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "readyState"
  );
  const requestFrameDescriptor = Object.getOwnPropertyDescriptor(
    HTMLVideoElement.prototype,
    "requestVideoFrameCallback"
  );
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
    configurable: true,
    get: () => HTMLMediaElement.HAVE_CURRENT_DATA
  });
  Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
    configurable: true,
    value: (callback: VideoFrameRequestCallback): number => {
      queueMicrotask(() => callback(0, {} as VideoFrameCallbackMetadata));
      return 1;
    }
  });
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 2992, height: 1934, close }) as unknown as ImageBitmap)
  );
  const drawImage = vi.fn();
  const getContext = vi.fn((kind: string) =>
    kind === "2d" ? ({ drawImage } as unknown as CanvasRenderingContext2D) : null
  );
  const canvas = { width: 0, height: 0, getContext } as unknown as HTMLCanvasElement;
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;

  try {
    const frozen = await acquireFrozenDisplayFrame(canvas, async () => stream);

    expect(frozen).toMatchObject({ width: 2992, height: 1934, transferMode: "2d" });
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(getContext).toHaveBeenCalledWith("2d", { alpha: false });
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {
    play.mockRestore();
    pause.mockRestore();
    vi.unstubAllGlobals();
    if (readyStateDescriptor === undefined) {
      Reflect.deleteProperty(HTMLMediaElement.prototype, "readyState");
    } else {
      Object.defineProperty(HTMLMediaElement.prototype, "readyState", readyStateDescriptor);
    }
    if (requestFrameDescriptor === undefined) {
      Reflect.deleteProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback");
    } else {
      Object.defineProperty(
        HTMLVideoElement.prototype,
        "requestVideoFrameCallback",
        requestFrameDescriptor
      );
    }
  }
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

test("stops an opened display stream when no video frame arrives", async () => {
  vi.useFakeTimers();
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockReturnValue(new Promise<void>(() => undefined));
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  try {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const acquire = acquireFrozenDisplayFrame(
      {} as HTMLCanvasElement,
      async () => stream,
      5
    );
    const rejection = expect(acquire).rejects.toThrow("timed out");
    await Promise.resolve();
    await Promise.resolve();
    expect(play).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5);
    await rejection;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
  } finally {
    play.mockRestore();
    pause.mockRestore();
    vi.useRealTimers();
  }
});

test("stops the stream and closes a late bitmap when bitmap creation times out", async () => {
  vi.useFakeTimers();
  const readyStateDescriptor = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "readyState"
  );
  const requestFrameDescriptor = Object.getOwnPropertyDescriptor(
    HTMLVideoElement.prototype,
    "requestVideoFrameCallback"
  );
  const cancelFrameDescriptor = Object.getOwnPropertyDescriptor(
    HTMLVideoElement.prototype,
    "cancelVideoFrameCallback"
  );
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
    configurable: true,
    get: () => HTMLMediaElement.HAVE_CURRENT_DATA
  });
  Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
    configurable: true,
    value: (callback: VideoFrameRequestCallback): number => {
      queueMicrotask(() => callback(0, {} as VideoFrameCallbackMetadata));
      return 1;
    }
  });
  Object.defineProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback", {
    configurable: true,
    value: vi.fn()
  });
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  let resolveBitmap!: (bitmap: ImageBitmap) => void;
  const bitmapPromise = new Promise<ImageBitmap>((resolve) => {
    resolveBitmap = resolve;
  });
  const createBitmap = vi.fn(() => bitmapPromise);
  vi.stubGlobal("createImageBitmap", createBitmap);
  const close = vi.fn();
  try {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const acquire = acquireFrozenDisplayFrame(
      {} as HTMLCanvasElement,
      async () => stream,
      5
    );
    const rejection = expect(acquire).rejects.toThrow("timed out");
    for (let i = 0; i < 5 && createBitmap.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(createBitmap).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5);
    await rejection;
    expect(stop).toHaveBeenCalledTimes(1);

    resolveBitmap({ width: 100, height: 100, close } as unknown as ImageBitmap);
    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    play.mockRestore();
    pause.mockRestore();
    vi.unstubAllGlobals();
    if (readyStateDescriptor === undefined) {
      Reflect.deleteProperty(HTMLMediaElement.prototype, "readyState");
    } else {
      Object.defineProperty(HTMLMediaElement.prototype, "readyState", readyStateDescriptor);
    }
    if (requestFrameDescriptor === undefined) {
      Reflect.deleteProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback");
    } else {
      Object.defineProperty(
        HTMLVideoElement.prototype,
        "requestVideoFrameCallback",
        requestFrameDescriptor
      );
    }
    if (cancelFrameDescriptor === undefined) {
      Reflect.deleteProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback");
    } else {
      Object.defineProperty(
        HTMLVideoElement.prototype,
        "cancelVideoFrameCallback",
        cancelFrameDescriptor
      );
    }
    vi.useRealTimers();
  }
});
