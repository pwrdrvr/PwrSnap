import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { VideoRange } from "@pwrsnap/shared";
import { HoverAutoplayVideo } from "../HoverAutoplayVideo";

const playback = vi.hoisted(() => ({ src: "fixture.mp4", beforeSwap: null as (() => void) | null }));
vi.mock("../useVideoPlaybackSrc", () => ({
  useVideoPlaybackSrc: (input: { onBeforeSwap: () => void }) => {
    playback.beforeSwap = input.onBeforeSwap;
    return playback.src;
  }
}));

let host: HTMLDivElement;
let root: Root;
let frame: VideoFrameRequestCallback | null;
let draw: ReturnType<typeof vi.fn>;
let clear: ReturnType<typeof vi.fn>;
let playing: boolean;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  frame = null;
  playing = false;
  playback.src = "fixture.mp4";
  draw = vi.fn();
  clear = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: draw, clearRect: clear
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    playing = true;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    playing = false;
    this.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => !playing);
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(4);
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
    configurable: true, value: vi.fn((cb: VideoFrameRequestCallback) => { frame = cb; return 1; })
  });
  Object.defineProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback", {
    configurable: true, value: vi.fn()
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
});

const selected = { start: 1.8, end: 3.4 };
async function render(range: VideoRange = selected, captureId = "clip"): Promise<HTMLVideoElement> {
  // Spread also lets this regression run against the old component,
  // which ignored the range entirely.
  const props = { captureId, video: null, range };
  await act(async () => root.render(createElement(HoverAutoplayVideo, props)));
  return host.querySelector("video")!;
}
function emit(video: HTMLVideoElement, event: string): void {
  act(() => video.dispatchEvent(new Event(event)));
}
function decoded(time: number): void {
  const callback = frame;
  expect(callback, "a decoded-frame guard must be registered").not.toBeNull();
  act(() => callback!(0, { mediaTime: time, width: 320, height: 180 } as VideoFrameCallbackMetadata));
}
function clock(): string | null {
  return host.querySelector('[data-testid="preview-timecode"]')?.textContent ?? null;
}

describe("trimmed hover preview", () => {
  test("shows trim-relative tenths before playback, never the source duration", async () => {
    const video = await render();
    expect(clock()).toBe("0:00.0 / 0:01.6");
    expect(video.controls).toBe(false);
    expect(host.querySelector('input[aria-label="Preview position"]')?.getAttribute("max")).toBe("1.6");
  });

  test("metadata load parks at the in-point before the first frame", async () => {
    const video = await render();
    video.currentTime = 0;
    emit(video, "loadedmetadata");
    expect(video.currentTime).toBe(1.8);
  });

  test.each([0, 1.79, 3.4, 4])("never paints a decoded frame outside the trim (%s s)", async (time) => {
    await render();
    decoded(time);
    expect(draw).not.toHaveBeenCalled();
    expect(host.querySelector("canvas")).not.toBeNull();
  });

  test("paints only a kept decoded frame and reports elapsed selection time", async () => {
    const video = await render();
    video.currentTime = 2.6;
    decoded(2.6);
    expect(draw).toHaveBeenCalled();
    expect(clock()).toBe("0:00.8 / 0:01.6");
  });

  test("playback stops at the out-point while the last kept picture remains", async () => {
    const video = await render();
    decoded(3.3);
    act(() => host.querySelector("[data-hover-autoplay]")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(video.paused).toBe(false);
    video.currentTime = 3.5;
    decoded(3.5);
    expect(video.paused).toBe(true);
    expect(clock()).toBe("0:01.6 / 0:01.6");
    expect(draw).toHaveBeenCalledTimes(1);
  });

  test("a trim change clears a paused frame that was removed and clamps the head", async () => {
    const video = await render({ start: 0, end: 4 });
    video.currentTime = 0.5;
    decoded(0.5);
    clear.mockClear();
    await render();
    expect(clear).toHaveBeenCalled();
    expect(video.currentTime).toBe(1.8);
    expect(clock()).toBe("0:00.0 / 0:01.6");
  });

  test("timeline seeks before or after the trim cannot expose a discarded picture", async () => {
    const video = await render();
    video.currentTime = 0;
    emit(video, "seeking");
    expect(video.currentTime).toBeGreaterThanOrEqual(1.8);
    video.currentTime = 4;
    emit(video, "seeking");
    expect(video.currentTime).toBeLessThan(3.4);
    expect(clock()).toBe("0:01.6 / 0:01.6");
    // Chromium fires another seeking/timeupdate after the corrective
    // seek. Those events must preserve the requested out-point clock.
    video.currentTime = Math.round(video.currentTime * 1_000_000) / 1_000_000;
    emit(video, "seeking");
    emit(video, "timeupdate");
    decoded(3.35);
    expect(clock()).toBe("0:01.6 / 0:01.6");
  });

  test("play from the out-point restarts at the selection's in-point", async () => {
    const video = await render();
    video.currentTime = 4;
    emit(video, "seeking");
    act(() => host.querySelector("button")!.click());
    expect(video.currentTime).toBe(1.8);
    expect(video.paused).toBe(false);
    expect(clock()).toBe("0:00.0 / 0:01.6");
  });

  test("a late decoded frame after a new trim cannot paint the abandoned selection", async () => {
    await render({ start: 0, end: 4 });
    const oldCallback = frame!;
    await render();
    draw.mockClear();
    act(() => oldCallback(0, { mediaTime: 0.5 } as VideoFrameCallbackMetadata));
    expect(draw).not.toHaveBeenCalled();
  });

  test("a late callback from the old source cannot copy the new source's untrimmed frame", async () => {
    await render();
    const oldCallback = frame!;
    playback.src = "mixed.mp4";
    await render();
    draw.mockClear();
    act(() => oldCallback(0, { mediaTime: 2.5, width: 320, height: 180 } as VideoFrameCallbackMetadata));
    expect(draw).not.toHaveBeenCalled();
  });

  test("a frame callback during a seek cannot copy an unverified picture", async () => {
    const video = await render();
    Object.defineProperty(video, "seeking", { configurable: true, value: true });
    decoded(2.5);
    expect(draw).not.toHaveBeenCalled();
    Object.defineProperty(video, "seeking", { configurable: true, value: false });
    decoded(2.5);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  test("a delayed kept-frame callback cannot copy media after the clock crosses the out-point", async () => {
    const video = await render();
    video.currentTime = 3.5;
    decoded(3.3);
    expect(draw).not.toHaveBeenCalled();
    expect(clock()).toBe("0:01.6 / 0:01.6");
  });

  test("expanding the trim after playback ends adopts the head's new relative time", async () => {
    const video = await render();
    video.currentTime = 3.5;
    emit(video, "timeupdate");
    expect(clock()).toBe("0:01.6 / 0:01.6");
    await render({ start: 0, end: 4 });
    expect(clock()).toBe("0:03.5 / 0:04.0");
  });

  test("timeline scrubbing back inside the trim resets an out-point readout", async () => {
    const video = await render();
    video.currentTime = 4;
    emit(video, "seeking");
    video.currentTime = 2.5;
    emit(video, "seeking");
    expect(clock()).toBe("0:00.7 / 0:01.6");
  });

  test("an audio rendition swap clamps the saved position to the latest trim", async () => {
    const video = await render({ start: 0, end: 4 });
    video.currentTime = 0.5;
    act(() => playback.beforeSwap!());
    playback.src = "mixed.mp4";
    await render();
    video.currentTime = 0;
    emit(video, "loadedmetadata");
    expect(video.currentTime).toBe(1.8);
    expect(clock()).toBe("0:00.0 / 0:01.6");
  });

  test("switching captures discards the previous head and displayed frame", async () => {
    const video = await render();
    video.currentTime = 3;
    decoded(3);
    clear.mockClear();
    await render({ start: 0.2, end: 0.9 }, "other");
    expect(clear).toHaveBeenCalled();
    expect(clock()).toBe("0:00.0 / 0:00.7");
  });
});
