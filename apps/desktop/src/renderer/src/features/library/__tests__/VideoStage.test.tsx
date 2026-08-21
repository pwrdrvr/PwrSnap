// Focus / keyboard-ownership tests for the Library video stage.
//
// The regression these lock down: the stage autofocused on mount
// unconditionally and `stopPropagation()`s the arrow keys it maps to
// frame stepping. React delegates to the root container, so that
// stop kills the native event before it reaches the Library's
// window-level keydown listener — which is what drives prev/next-
// capture navigation in Reel mode. Result: arrowing between captures
// died the moment a video scrolled into the reel.
//
// Focus mode SHOULD own the arrows (single-capture surface, nothing
// else wants the keyboard). Reel must not — until the user actually
// clicks into the video, at which point the stage holds focus and
// frame stepping is what they asked for.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, VideoCaptureMetadata } from "@pwrsnap/shared";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The timeline's asset hook dispatches `video:frames` / `video:audio`
  // on mount. Answer with a rejection so nothing tries to fetch a
  // blob under jsdom — the assets are irrelevant to focus behavior.
  (globalThis as unknown as { window: { pwrsnapApi: unknown } }).window.pwrsnapApi = {
    dispatch: async () => ({
      ok: false,
      error: { kind: "validation", code: "test_stub", message: "stubbed" }
    }),
    on: () => () => undefined,
    startCaptureDrag: () => undefined,
    startVideoDrag: () => undefined
  };
});

const { VideoStage } = await import("../VideoStage");

const video: VideoCaptureMetadata = {
  durationSec: 10,
  containerFormat: "mp4",
  hasSystemAudio: false,
  hasMicrophoneAudio: false,
  defaultRange: { start: 0, end: 10 },
  previewPath: null,
  previewStatus: "ready"
} as unknown as VideoCaptureMetadata;

const record = {
  id: "cap_1",
  kind: "video",
  width_px: 1920,
  height_px: 1080,
  video
} as unknown as CaptureRecord;

// A `trim` stand-in with the `UseVideoTrimRange` shape. Library owns
// the real hook now; the stage just consumes it.
const trim = {
  range: { start: 0, end: 10 },
  setRange: () => undefined,
  pending: false
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

function mountStage(reel: boolean): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(VideoStage, { record, video, trim, reel }));
  });
  const stage = container.querySelector<HTMLElement>('[data-testid="video-stage"]');
  if (stage === null) throw new Error("video stage did not render");
  return stage;
}

/** Like `mountStage`, but with a `trim` that actually holds state, so
 *  `setRange` feeds a new range back through props the way the real
 *  Library-level `useVideoTrimRange` does. Needed by anything that
 *  depends on the stage seeing a committed range change. */
function mountStatefulStage(initialRange = { start: 0, end: 10 }): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let current = initialRange;
  const paint = (): void => {
    root!.render(
      createElement(VideoStage, {
        record,
        video,
        reel: false,
        trim: { range: current, setRange, pending: false }
      })
    );
  };
  function setRange(next: { start: number; end: number }): void {
    current = next;
    paint();
  }
  act(() => paint());
  const stage = container.querySelector<HTMLElement>('[data-testid="video-stage"]');
  if (stage === null) throw new Error("video stage did not render");
  return stage;
}

/** Dispatch a keydown the way the browser would for the CURRENTLY
 *  focused element, and report whether a window-level listener (the
 *  Library's capture navigation) saw it. */
function pressArrowRight(): boolean {
  let sawIt = false;
  const onKey = (): void => {
    sawIt = true;
  };
  window.addEventListener("keydown", onKey);
  try {
    const target = document.activeElement ?? document.body;
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
      );
    });
  } finally {
    window.removeEventListener("keydown", onKey);
  }
  return sawIt;
}

describe("VideoStage keyboard ownership", () => {
  test("Reel mode: does not steal focus on mount", () => {
    const stage = mountStage(true);
    expect(document.activeElement).not.toBe(stage);
    expect(stage.contains(document.activeElement)).toBe(false);
  });

  test("Reel mode: ArrowRight is not swallowed — capture navigation still fires", () => {
    mountStage(true);
    expect(pressArrowRight()).toBe(true);
  });

  test("Focus mode: autofocuses the stage on mount", () => {
    const stage = mountStage(false);
    expect(document.activeElement).toBe(stage);
  });

  test("Focus mode: ArrowRight is swallowed by the transport (frame step)", () => {
    mountStage(false);
    expect(pressArrowRight()).toBe(false);
  });

  test("Reel mode: clicking into the video arms the transport, and the arrows follow focus", () => {
    const stage = mountStage(true);
    act(() => {
      stage.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(stage);
    // Now the stage owns the keyboard: frame stepping works and the
    // window handler correctly does NOT also navigate.
    expect(pressArrowRight()).toBe(false);
  });
});

// Dragging the timeline while the clip is playing used to fight itself:
// the element kept advancing between the drag's seeks, so the frame
// under the handle was never the frame on screen and the playhead
// wandered off on its own. The gesture now pauses for its duration and
// restores playback on release.
describe("VideoStage timeline drag vs playback", () => {
  function stubMedia(): { calls: string[]; restore: () => void } {
    const calls: string[] = [];
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(function (this: HTMLMediaElement) {
        calls.push("play");
        return Promise.resolve();
      });
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(function (this: HTMLMediaElement) {
        calls.push("pause");
      });
    return {
      calls,
      restore: () => {
        play.mockRestore();
        pause.mockRestore();
      }
    };
  }

  function pointerOn(el: Element, type: string, clientX: number): void {
    act(() => {
      el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 5, button: 0 })
      );
    });
  }

  function handles(stage: HTMLElement): { inHandle: Element; strip: Element } {
    return {
      inHandle: stage.querySelector('[data-testid="video-timeline-in"]')!,
      strip: stage.querySelector(".vtl__strip")!
    };
  }

  test("pauses for the drag and resumes when it was playing", () => {
    const media = stubMedia();
    try {
      const stage = mountStage(false);
      // The stage tracks playback off the element's own events.
      act(() => {
        stage.querySelector("video")!.dispatchEvent(new Event("play"));
      });

      const { inHandle, strip } = handles(stage);
      pointerOn(inHandle, "pointerdown", 10);
      pointerOn(strip, "pointermove", 40);
      expect(media.calls).toEqual(["pause"]);

      pointerOn(strip, "pointerup", 40);
      expect(media.calls).toEqual(["pause", "play"]);
    } finally {
      media.restore();
    }
  });

  // `play()` reads `rangeRef`, which is assigned during render — so in
  // the drag-end callback's own tick it still holds the range as of the
  // last commit. Escape-cancel restores the range and ends the drag in
  // one tick, so resuming inline would test the head against the range
  // the user just abandoned and snap it to that in-point. The resume
  // has to wait for the commit.
  test("Escape-cancel resumes against the restored range, not the abandoned one", () => {
    const media = stubMedia();
    // jsdom has no layout; 800 px over a 10 s clip → 80 px per second.
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 80,
      width: 800,
      height: 80,
      toJSON: () => ({})
    } as DOMRect);
    try {
      const stage = mountStatefulStage();
      const el = stage.querySelector("video")!;
      act(() => {
        el.dispatchEvent(new Event("play"));
      });

      // Drag the in-handle out to 5 s, then back out of the whole thing.
      const { inHandle, strip } = handles(stage);
      pointerOn(inHandle, "pointerdown", 0);
      pointerOn(strip, "pointermove", 400);
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      });

      expect(media.calls).toEqual(["pause", "play"]);
      // The head must sit at the RESTORED in-point. Resuming inline
      // would have let `play()`'s loop-in-range check read the
      // abandoned {start: 5} range and snap the head to 5.
      expect(el.currentTime).toBe(0);
    } finally {
      rect.mockRestore();
      media.restore();
    }
  });

  test("a drag started while paused does not start playback on release", () => {
    const media = stubMedia();
    try {
      const stage = mountStage(false);
      const { inHandle, strip } = handles(stage);
      pointerOn(inHandle, "pointerdown", 10);
      pointerOn(strip, "pointermove", 40);
      pointerOn(strip, "pointerup", 40);
      expect(media.calls).not.toContain("play");
    } finally {
      media.restore();
    }
  });
});

// The playhead is published on its own channel (`shared/playhead.ts`)
// rather than through `useState`, so a playing video does not re-render
// the transport + timeline on every animation frame (#446) — and the
// publish itself is throttled off vsync, because any per-frame DOM
// mutation makes the compositor produce a frame at the DISPLAY's rate
// (#447). What has to keep working regardless: the head and the
// timecode still advance, discrete positions (wrap, seek, pause) land
// immediately, and the loop-in-range wrap still fires every frame.
describe("VideoStage playhead loop", () => {
  function stubMediaClock(el: HTMLVideoElement): { t: number } {
    const clock = { t: 0 };
    // jsdom has no media pipeline: give the element a clock we drive.
    Object.defineProperty(el, "currentTime", {
      configurable: true,
      get: () => clock.t,
      set: (next: number) => {
        clock.t = next;
      }
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    return clock;
  }

  /** Hand-cranked rAF so a "frame" is a deliberate step, not a wait.
   *  `step` takes the frame timestamp because the publish throttle is
   *  keyed off it — stepping without moving the clock is a frame the
   *  head is SUPPOSED to skip. */
  function stubRaf(): { step: (nowMs?: number) => void; pending: () => boolean } {
    let queued: FrameRequestCallback | null = null;
    let handle = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      queued = cb;
      handle += 1;
      return handle;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      queued = null;
    });
    return {
      step: (nowMs = 0): void => {
        const cb = queued;
        queued = null;
        if (cb !== null) act(() => cb(nowMs));
      },
      pending: (): boolean => queued !== null
    };
  }

  /** Hand-cranked `requestVideoFrameCallback`. jsdom has none, so an
   *  element only gets one when a test says it does — which is also
   *  what the production code relies on to fall back to rAF. */
  function stubVideoFrameCallback(el: HTMLVideoElement): {
    frame: (nowMs: number, mediaTimeSec: number) => void;
    cancelled: () => boolean;
  } {
    let queued: VideoFrameRequestCallback | null = null;
    let handle = 0;
    let cancelled = false;
    Object.defineProperty(el, "requestVideoFrameCallback", {
      configurable: true,
      value: (cb: VideoFrameRequestCallback): number => {
        queued = cb;
        handle += 1;
        return handle;
      }
    });
    Object.defineProperty(el, "cancelVideoFrameCallback", {
      configurable: true,
      value: (): void => {
        cancelled = true;
        queued = null;
      }
    });
    return {
      frame: (nowMs: number, mediaTimeSec: number): void => {
        const cb = queued;
        queued = null;
        if (cb === null) return;
        act(() =>
          cb(nowMs, {
            expectedDisplayTime: nowMs,
            height: 1080,
            mediaTime: mediaTimeSec,
            presentationTime: nowMs,
            presentedFrames: 1,
            width: 1920
          })
        );
      },
      cancelled: (): boolean => cancelled
    };
  }

  function stubRect(widthPx: number): void {
    // jsdom has no layout; 800 px over a 10 s clip → 80 px per second.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: widthPx,
      bottom: 80,
      width: widthPx,
      height: 80,
      toJSON: () => ({})
    } as DOMRect);
  }

  const headOf = (stage: HTMLElement): HTMLElement =>
    stage.querySelector<HTMLElement>('[data-testid="video-timeline-playhead"]')!;
  /** The head's x in px. Numeric, not the `transform` string: `sec /
   *  duration * width` lands on 440.00000000000006 for plenty of
   *  perfectly ordinary inputs. */
  const headXOf = (stage: HTMLElement): number =>
    Number(/translateX\(([-\d.]+)px\)/.exec(headOf(stage).style.transform)?.[1] ?? NaN);
  const timecodeOf = (stage: HTMLElement): string =>
    stage.querySelector('[data-testid="video-transport-time"] b')!.textContent ?? "";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("advances the head and the timecode while playing", () => {
    stubRect(800);
    const raf = stubRaf();
    const stage = mountStage(false);
    const video = stage.querySelector("video")!;
    const clock = stubMediaClock(video);

    act(() => video.dispatchEvent(new Event("play")));

    clock.t = 4;
    raf.step(1000);
    expect(headOf(stage).style.transform).toBe("translateX(320px)");
    expect(timecodeOf(stage)).toBe("0:04.0");

    clock.t = 6.25;
    raf.step(1040);
    expect(headOf(stage).style.transform).toBe("translateX(500px)");
    expect(timecodeOf(stage)).toBe("0:06.2");
  });

  // The point of PR #447: a head that moves every rAF forces a
  // compositor frame at every vsync — 120 Hz on a ProMotion display —
  // which measured MORE CPU than decoding and compositing the video.
  // See the rate constants in `VideoStage.tsx`.
  test("publishes at most ~30 Hz, so vsync does not drive the compositor", () => {
    stubRect(800);
    const raf = stubRaf();
    const stage = mountStage(false);
    const video = stage.querySelector("video")!;
    const clock = stubMediaClock(video);

    act(() => video.dispatchEvent(new Event("play")));

    clock.t = 4;
    raf.step(1000);
    expect(headXOf(stage)).toBeCloseTo(320, 6);

    // Three 120 Hz frames inside the 33 ms window: the wrap check runs
    // every one of them, the head moves on none of them.
    clock.t = 4.1;
    raf.step(1008);
    clock.t = 4.2;
    raf.step(1016);
    clock.t = 4.3;
    raf.step(1024);
    expect(headXOf(stage)).toBeCloseTo(320, 6);
    expect(raf.pending()).toBe(true);

    clock.t = 4.5;
    raf.step(1033);
    expect(headXOf(stage)).toBeCloseTo(360, 6);
  });

  // Discrete jumps must never be swallowed by the throttle — the
  // picture snaps back at the out-point, so a head still drawing the
  // far end for a beat reads as a glitch.
  test("the loop-in-range wrap places the head immediately", () => {
    stubRect(800);
    const raf = stubRaf();
    const stage = mountStatefulStage({ start: 2, end: 6 });
    const video = stage.querySelector("video")!;
    const clock = stubMediaClock(video);

    act(() => video.dispatchEvent(new Event("play")));
    clock.t = 5.5;
    raf.step(1000);
    expect(headXOf(stage)).toBeCloseTo(440, 6);

    // 8 ms later — well inside the throttle window — the range ends.
    clock.t = 6;
    raf.step(1008);
    expect(clock.t).toBe(2);
    expect(headXOf(stage)).toBeCloseTo(160, 6);
  });

  // A seek is user-driven and discrete: it goes through `publishTime`,
  // not the throttled playback path, so it lands on the frame it
  // happens on no matter where the throttle window sits.
  test("a scrub during playback places the head immediately", () => {
    stubRect(800);
    const raf = stubRaf();
    const stage = mountStage(false);
    const video = stage.querySelector("video")!;
    const clock = stubMediaClock(video);

    act(() => video.dispatchEvent(new Event("play")));
    clock.t = 4;
    raf.step(1000);
    expect(headXOf(stage)).toBeCloseTo(320, 6);

    const strip = stage.querySelector<HTMLElement>('[data-testid="video-timeline"] .vtl__strip')!;
    act(() => {
      strip.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          clientX: 600,
          clientY: 5,
          button: 0
        })
      );
    });
    expect(headXOf(stage)).toBeCloseTo(600, 6);
    expect(timecodeOf(stage)).toBe("0:07.5");
  });

  // rVFC fires once per DECODED frame, so it self-limits to the media
  // rate — there is no reason to move the head faster than the picture.
  test("requestVideoFrameCallback drives the head when the element has it", () => {
    stubRect(800);
    const raf = stubRaf();
    const stage = mountStage(false);
    const video = stage.querySelector("video")!;
    const clock = stubMediaClock(video);
    const vfc = stubVideoFrameCallback(video);

    act(() => video.dispatchEvent(new Event("play")));

    clock.t = 4;
    vfc.frame(1000, 4);
    expect(headXOf(stage)).toBeCloseTo(320, 6);

    // Once rVFC has fired, the rAF loop backs off to the gap floor: it
    // keeps running the wrap check, but stops publishing.
    clock.t = 4.5;
    raf.step(1040);
    expect(headXOf(stage)).toBeCloseTo(320, 6);

    clock.t = 5;
    vfc.frame(1060, 5);
    expect(headXOf(stage)).toBeCloseTo(400, 6);
  });

  // The head follows the element, not `meta.mediaTime`: a frame decoded
  // just before a loop wrap arrives AFTER the wrap has already put the
  // head back at the in-point, and drawing its `mediaTime` would flick
  // the head to the far end. No magnitude heuristic survives a range
  // shorter than the threshold, and `MIN_RANGE_SEC` is 0.1 s.
  test("a video frame published after a wrap draws the wrapped position", () => {
    stubRect(800);
    const raf = stubRaf();
    const stage = mountStatefulStage({ start: 2, end: 2.1 });
    const video = stage.querySelector("video")!;
    const clock = stubMediaClock(video);
    const vfc = stubVideoFrameCallback(video);

    act(() => video.dispatchEvent(new Event("play")));
    clock.t = 2.1;
    raf.step(1000);
    expect(clock.t).toBe(2);
    expect(headXOf(stage)).toBeCloseTo(160, 6);

    // The straggler: decoded at 2.09, delivered after the wrap. Only
    // 0.09 s from the wrapped position, so no threshold saves this.
    vfc.frame(1040, 2.09);
    expect(headXOf(stage)).toBeCloseTo(160, 6);
  });

  // VFR screen recordings can go a long time between frames when
  // nothing on screen moved. The clock is still running, so the head
  // must not stall with it.
  test("rAF covers a long gap between decoded frames", () => {
    stubRect(800);
    const raf = stubRaf();
    const stage = mountStage(false);
    const video = stage.querySelector("video")!;
    const clock = stubMediaClock(video);
    const vfc = stubVideoFrameCallback(video);

    act(() => video.dispatchEvent(new Event("play")));
    clock.t = 1;
    vfc.frame(1000, 1);
    expect(headXOf(stage)).toBeCloseTo(80, 6);

    clock.t = 3;
    raf.step(1051);
    expect(headXOf(stage)).toBeCloseTo(240, 6);
  });

  test("pausing cancels the video-frame callback too", () => {
    stubRect(800);
    stubRaf();
    const stage = mountStage(false);
    const video = stage.querySelector("video")!;
    stubMediaClock(video);
    const vfc = stubVideoFrameCallback(video);

    act(() => video.dispatchEvent(new Event("play")));
    vfc.frame(1000, 1);
    expect(vfc.cancelled()).toBe(false);

    act(() => video.dispatchEvent(new Event("pause")));
    expect(vfc.cancelled()).toBe(true);
  });

  test("loop-in-range still wraps the element back to the in-point", () => {
    stubRect(800);
    const raf = stubRaf();
    const stage = mountStatefulStage({ start: 2, end: 6 });
    const video = stage.querySelector("video")!;
    const clock = stubMediaClock(video);

    act(() => video.dispatchEvent(new Event("play")));

    clock.t = 6;
    raf.step();
    expect(clock.t).toBe(2);
    expect(headOf(stage).style.transform).toBe("translateX(160px)");
    expect(timecodeOf(stage)).toBe("0:02.0");
  });

  // The persisted `durationSec` is wall-clock elapsed recording time
  // (recording-service.ts), so it runs longer than the encoded media.
  // For a real recording the rAF wrap threshold therefore sits past
  // where the media ends and is never reached — which used to leave
  // loop-in-range parked at the end after a single pass.
  test("whole-clip loop-in-range loops on the element, not the rAF wrap", () => {
    const stage = mountStage(false);
    // `video` above is the whole clip: durationSec 10, range [0, 10].
    expect(stage.querySelector("video")!.loop).toBe(true);
  });

  test("a trimmed range does not take the element's loop", () => {
    const stage = mountStatefulStage({ start: 2, end: 6 });
    expect(stage.querySelector("video")!.loop).toBe(false);
  });

  test("ended wraps a trimmed range whose out-point the wrap never reached", () => {
    const raf = stubRaf();
    const stage = mountStatefulStage({ start: 2, end: 10 });
    const video = stage.querySelector("video")!;
    const clock = stubMediaClock(video);
    // Row says 10 s; the media really ends at 9.7 s, so `t >= 9.995`
    // never happens and the element fires `ended` instead.
    Object.defineProperty(video, "duration", { value: 9.7, configurable: true });

    act(() => video.dispatchEvent(new Event("play")));
    clock.t = 9.7;
    raf.step();
    // `stubMediaClock` stubs play()/pause(), so jsdom's own `paused`
    // never moves — the resumed playback shows up as the call.
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    act(() => video.dispatchEvent(new Event("ended")));

    expect(clock.t).toBe(2);
    expect(play).toHaveBeenCalled();
  });

  // Guard against the inverse: a range start PAST the media end clamps
  // straight back to the end and re-fires `ended`, so replaying there
  // spins (measured 61 ended / 62 play() in 6 s before this guard).
  test("ended does not replay when the range start is past the media end", () => {
    const stage = mountStatefulStage({ start: 5, end: 10 });
    const video = stage.querySelector("video")!;
    stubMediaClock(video);
    Object.defineProperty(video, "duration", { value: 2, configurable: true });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);

    act(() => video.dispatchEvent(new Event("play")));
    play.mockClear();
    act(() => video.dispatchEvent(new Event("ended")));

    expect(play).not.toHaveBeenCalled();
  });

  // `play()` snaps the head to the in-point when playback would start
  // outside the range. If the element then refuses to play, no `play`
  // event fires, so neither frame loop starts — both are gated on
  // `playing` — and nothing downstream would ever correct the head.
  // `play()` publishes the snap itself.
  test("a rejected play() still publishes the in-point snap", async () => {
    stubRect(800);
    stubRaf();
    const stage = mountStatefulStage({ start: 2, end: 8 });
    const video = stage.querySelector("video")!;
    const clock = stubMediaClock(video);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("decode failed"));

    // Parked past the out-point, so `play()` will snap to the in-point.
    clock.t = 9.5;
    await act(async () => {
      stage
        .querySelector<HTMLButtonElement>('[data-testid="video-transport-play"]')!
        .click();
    });

    expect(clock.t).toBe(2);
    expect(headOf(stage).style.transform).toBe("translateX(160px)");
    expect(timecodeOf(stage)).toBe("0:02.0");
  });

  test("pausing stops the loop and leaves the head where the element is", () => {
    stubRect(800);
    const raf = stubRaf();
    const stage = mountStage(false);
    const video = stage.querySelector("video")!;
    const clock = stubMediaClock(video);

    act(() => video.dispatchEvent(new Event("play")));
    clock.t = 4;
    raf.step();
    expect(raf.pending()).toBe(true);

    act(() => video.dispatchEvent(new Event("pause")));
    expect(raf.pending()).toBe(false);
    expect(headOf(stage).style.transform).toBe("translateX(320px)");
    expect(timecodeOf(stage)).toBe("0:04.0");
  });
});
