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
