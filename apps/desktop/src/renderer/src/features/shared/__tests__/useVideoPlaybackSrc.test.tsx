import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

const dispatchMock = vi.fn();

vi.mock("../../../lib/pwrsnap", () => ({
  captureSrcUrl: (id: string) => `pwrsnap-capture://r/${id}`,
  dispatch: (...args: unknown[]) => dispatchMock(...args)
}));

import { useVideoPlaybackSrc } from "../useVideoPlaybackSrc";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  dispatchMock.mockReset();
});

type Facts = Parameters<typeof useVideoPlaybackSrc>[0]["video"];

async function render(
  video: Facts,
  onBeforeSwap?: () => void,
  captureId = "cap1"
): Promise<{ src: () => string }> {
  let seen = "";
  function Probe(): null {
    seen = useVideoPlaybackSrc({ captureId, video, onBeforeSwap });
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Probe));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { src: () => seen };
}

/** Both audible, so they must be mixed — the shape that needs a rendition. */
const bothAudible = {
  hasSystemAudio: true,
  hasMicrophoneAudio: true,
  requestedSystemAudio: true,
  requestedMicrophone: true
};

/** The common bug: system armed but silent, in front of a live microphone. */
const silentSystemLiveMic = {
  hasSystemAudio: false,
  hasMicrophoneAudio: true,
  requestedSystemAudio: true,
  requestedMicrophone: true
};

describe("useVideoPlaybackSrc", () => {
  test("serves the capture URL synchronously, before any resolution lands", async () => {
    dispatchMock.mockReturnValue(new Promise(() => undefined));
    const probe = await render(bothAudible);
    // The player must paint its first frame while the question is open;
    // leaving the element empty until main answers is a blank preview.
    expect(probe.src()).toBe("pwrsnap-capture://r/cap1");
  });

  // The gate is the whole reason this hook exists: the verb can spawn a
  // stream-copy remux the size of the recording, so a capture that cannot
  // need one must not reach the bus at all.
  test.each([
    ["no audio at all", { hasSystemAudio: false, hasMicrophoneAudio: false, requestedSystemAudio: false, requestedMicrophone: false }],
    ["system only, already the first track", { hasSystemAudio: true, hasMicrophoneAudio: false, requestedSystemAudio: true, requestedMicrophone: false }],
    ["mic only, so it IS the first track", { hasSystemAudio: false, hasMicrophoneAudio: true, requestedSystemAudio: false, requestedMicrophone: false }],
    ["no video metadata", null],
    ["undefined video metadata", undefined]
  ])("never dispatches for %s", async (_label, video) => {
    const probe = await render(video as Facts);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(probe.src()).toBe("pwrsnap-capture://r/cap1");
  });

  test.each([
    ["both audible, so they must be mixed", bothAudible],
    ["a silent system track in front of a live mic", silentSystemLiveMic]
  ])("dispatches and swaps for %s", async (_label, video) => {
    dispatchMock.mockResolvedValue({ ok: true, value: { url: "pwrsnap-cache://v/cap1/p.mp4", prepared: true } });
    const probe = await render(video);
    expect(dispatchMock).toHaveBeenCalledWith("video:playback", { captureId: "cap1" });
    expect(probe.src()).toBe("pwrsnap-cache://v/cap1/p.mp4");
  });

  test("announces the swap before the URL changes, so a caller can save its position", async () => {
    dispatchMock.mockResolvedValue({ ok: true, value: { url: "pwrsnap-cache://v/cap1/p.mp4", prepared: true } });
    const order: string[] = [];
    // Assigning `src` runs the media load algorithm: the element stops and
    // rewinds to 0 WITHOUT firing `pause`. A caller that reads its position
    // after the swap reads zeros, so the callback has to land first.
    await render(bothAudible, () => order.push("before-swap"));
    expect(order).toEqual(["before-swap"]);
  });

  // Falling back is the whole error policy: the seed is what shipped before
  // this verb existed, so a failure can only ever be a no-op.
  test.each([
    ["an error result", async () => ({ ok: false, error: { kind: "render", code: "x", message: "x" } })],
    ["a rejected invoke", async () => { throw new Error("bridge torn down"); }],
    ["a resolution identical to the seed", async () => ({ ok: true, value: { url: "pwrsnap-capture://r/cap1", prepared: false } })]
  ])("keeps the capture URL on %s", async (_label, impl) => {
    dispatchMock.mockImplementation(impl);
    const swaps: string[] = [];
    const probe = await render(bothAudible, () => swaps.push("swap"));
    expect(probe.src()).toBe("pwrsnap-capture://r/cap1");
    expect(swaps).toEqual([]);
  });

  test("does not re-dispatch when a caller passes a fresh closure each render", async () => {
    dispatchMock.mockResolvedValue({ ok: true, value: { url: "pwrsnap-cache://v/cap1/p.mp4", prepared: true } });
    function Probe(): null {
      // A new function identity every render — what an inline arrow gives
      // you, and what the float-over produces at 60 Hz while its dismiss
      // countdown ticks. In the effect's deps that is a remux per frame.
      useVideoPlaybackSrc({ captureId: "cap1", video: bothAudible, onBeforeSwap: () => undefined });
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root?.render(createElement(Probe)); });
    for (let i = 0; i < 5; i++) {
      await act(async () => { root?.render(createElement(Probe)); });
    }
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});
