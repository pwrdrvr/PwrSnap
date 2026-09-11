import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { usePreparedVideoPlayback } from "../usePreparedVideoPlayback";
import { VideoPlaybackStatus } from "../VideoPlaybackStatus";
import { HoverAutoplayVideo } from "../HoverAutoplayVideo";

const original = "pwrsnap-capture://r/capture_1";
const prepared = `${original}?playback=1`;
let container: HTMLDivElement;
let root: Root;
let requests: { signal: AbortSignal; resolve: (response: Response) => void }[];

function Player({ src = original, target = prepared }: { src?: string; target?: string | undefined }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const playback = usePreparedVideoPlayback(ref, src, target);
  return <>
    <video ref={ref} src={playback.src} muted={playback.audioUnavailable}
      onLoadedMetadata={playback.onLoadedMetadata} onError={playback.onError} />
    <VideoPlaybackStatus playback={playback} />
  </>;
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  requests = [];
  vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({ signal: options.signal as AbortSignal, resolve });
  })));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function media(): HTMLVideoElement { return container.querySelector("video")!; }
function loaded(): void {
  Object.defineProperty(media(), "currentSrc", { configurable: true, value: media().src });
  Object.defineProperty(media(), "duration", { configurable: true, value: 60 });
  act(() => media().dispatchEvent(new Event("loadedmetadata")));
}
async function finish(index = 0, status = 200): Promise<void> {
  await act(async () => requests[index]!.resolve(new Response(null, { status })));
}

describe("background playback preparation", () => {
  test("exposes original metadata and seeks while preparation remains unresolved", () => {
    act(() => root.render(<Player />));
    expect(media().src).toBe(original);
    expect(fetch).toHaveBeenCalledWith(prepared, expect.objectContaining({ method: "HEAD", cache: "no-store" }));
    loaded();
    media().currentTime = 42;
    expect(media().currentTime).toBe(42);
    expect(media().muted).toBe(true);
    expect(container.textContent).toContain("Preparing audio...");
    expect(media().src).toBe(original);
  });

  test.each([true, false])("restores the playhead, rate, volume and paused=%s on publication", async (paused) => {
    act(() => root.render(<Player />));
    loaded();
    media().currentTime = 23;
    media().playbackRate = 2;
    media().volume = 0.25;
    Object.defineProperty(media(), "paused", { configurable: true, value: paused });
    await finish();
    expect(media().src).toBe(prepared);
    expect(media().muted).toBe(true);
    // A real media load resets these properties before loadedmetadata.
    media().currentTime = 0;
    media().playbackRate = 1;
    media().volume = 1;
    loaded();
    expect(media().currentTime).toBe(23);
    expect(media().playbackRate).toBe(2);
    expect(media().volume).toBe(0.25);
    expect(media().play).toHaveBeenCalledTimes(paused ? 0 : 1);
    expect(media().muted).toBe(false);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test("keeps the original on failure and permits retry", async () => {
    act(() => root.render(<Player />));
    await finish(0, 500);
    expect(media().src).toBe(original);
    expect(container.textContent).toContain("Audio preview unavailable");
    act(() => container.querySelector("button")!.click());
    expect(requests).toHaveLength(2);
    expect(container.textContent).toContain("Preparing audio...");
    await finish(1);
    loaded();
    expect(media().src).toBe(prepared);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test("falls back to the original if the prepared media cannot decode", async () => {
    act(() => root.render(<Player />));
    media().currentTime = 17;
    await finish();
    act(() => media().dispatchEvent(new Event("error")));
    expect(media().src).toBe(original);
    media().currentTime = 0;
    loaded();
    expect(media().currentTime).toBe(17);
    expect(media().muted).toBe(true);
    expect(container.textContent).toContain("Audio preview unavailable");
  });

  test("capture changes abort the old request and ignore its eventual result", async () => {
    act(() => root.render(<Player />));
    const next = "pwrsnap-capture://r/capture_2";
    act(() => root.render(<Player src={next} target={`${next}?playback=1`} />));
    expect(requests[0]!.signal.aborted).toBe(true);
    await finish();
    expect(media().src).toBe(next);
    await finish(1);
    loaded();
    expect(media().src).toBe(`${next}?playback=1`);
    expect(media().currentTime).toBe(0);
  });

  test("unmount aborts preparation without updating a disposed player", async () => {
    act(() => root.render(<Player />));
    act(() => root.render(null));
    expect(requests[0]!.signal.aborted).toBe(true);
    await finish();
    expect(container.children).toHaveLength(0);
  });

  test("the hover preview loads the original muted and enables audio controls only after publication", async () => {
    act(() => root.render(<HoverAutoplayVideo src={original} playbackSrc={prepared} />));
    expect(media().src).toBe(original);
    expect(media().muted).toBe(true);
    expect(media().controls).toBe(false);
    media().currentTime = 12;
    await finish();
    loaded();
    expect(media().src).toBe(prepared);
    expect(media().currentTime).toBe(12);
    expect(media().controls).toBe(true);
  });

  test("single-track hover previews need no preparation", () => {
    act(() => root.render(<HoverAutoplayVideo src={original} />));
    expect(media().src).toBe(original);
    expect(media().controls).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test("leaving the hover preview during source replacement cancels its pending resume", async () => {
    act(() => root.render(<HoverAutoplayVideo src={original} playbackSrc={prepared} />));
    Object.defineProperty(media(), "paused", { configurable: true, value: false });
    await finish();
    act(() => container.querySelector("[data-hover-autoplay]")!.dispatchEvent(new Event("mouseleave")));
    expect(media().pause).toHaveBeenCalledOnce();
    loaded();
    expect(media().play).not.toHaveBeenCalled();
  });
});
