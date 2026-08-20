// Component tests for the trim timeline: handle drags report
// `commit=false` while moving and `commit=true` on release, the strip
// body scrubs (seek), the scrim / labels follow the range, and the
// compact variant hides playhead + waveform. jsdom has no layout, so
// the strip's bounding rect is stubbed to 800 px.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { VideoRange } from "@pwrsnap/shared";
import { createPlayheadSource } from "../playhead";
import { VideoTimeline, type VideoTimelineProps } from "../VideoTimeline";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let rectSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 800,
        bottom: 80,
        width: 800,
        height: 80,
        toJSON: () => ({})
      }) as DOMRect
  );
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  rectSpy?.mockRestore();
  rectSpy = null;
});

function render(
  props: Partial<VideoTimelineProps> & { range: VideoRange },
  onParentClick?: () => void
): {
  el: HTMLDivElement;
  rerender: (next: Partial<VideoTimelineProps> & { range: VideoRange }) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const base = (p: Partial<VideoTimelineProps> & { range: VideoRange }): VideoTimelineProps => ({
    durationSec: 16,
    currentTime: 0,
    frames: null,
    audioBlob: null,
    onRangeChange: () => undefined,
    ...p
  });
  act(() =>
    root!.render(
      createElement("div", { onClick: onParentClick }, createElement(VideoTimeline, base(props)))
    )
  );
  return {
    el: container,
    rerender: (next) =>
      act(() =>
        root!.render(
          createElement("div", { onClick: onParentClick }, createElement(VideoTimeline, base(next)))
        )
      )
  };
}

function pointer(el: Element, type: string, clientX: number): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 10, button: 0 })
    );
  });
}

describe("VideoTimeline", () => {
  test("dragging the in-handle reports uncommitted moves, then commits on release", () => {
    const changes: Array<{ range: VideoRange; commit: boolean }> = [];
    const { el } = render({
      range: { start: 0, end: 16 },
      onRangeChange: (range, commit) => changes.push({ range, commit })
    });
    const inHandle = el.querySelector('[data-testid="video-timeline-in"]') as HTMLButtonElement;
    const strip = el.querySelector(".vtl__strip")!;
    // 800 px ↔ 16 s → 50 px per second.
    pointer(inHandle, "pointerdown", 100);
    pointer(strip, "pointermove", 170);
    pointer(strip, "pointerup", 170);
    expect(changes).toEqual([
      { range: { start: 2, end: 16 }, commit: false },
      { range: { start: 3.4, end: 16 }, commit: false },
      { range: { start: 3.4, end: 16 }, commit: true }
    ]);
  });

  test("consumes the click synthesized after a trim-handle drag", () => {
    let parentClicks = 0;
    const { el } = render(
      { range: { start: 0, end: 16 } },
      () => {
        parentClicks += 1;
      }
    );
    const inHandle = el.querySelector('[data-testid="video-timeline-in"]') as HTMLButtonElement;
    const strip = el.querySelector(".vtl__strip")!;

    pointer(inHandle, "pointerdown", 0);
    pointer(strip, "pointermove", 170);
    pointer(strip, "pointerup", 170);
    act(() => inHandle.click());

    expect(parentClicks).toBe(0);
  });

  test("dragging a trim handle seeks the preview to the edge it lands on", () => {
    const seeks: number[] = [];
    const { el } = render({
      range: { start: 0, end: 16 },
      onSeek: (sec) => seeks.push(sec)
    });
    const outHandle = el.querySelector('[data-testid="video-timeline-out"]')!;
    const strip = el.querySelector(".vtl__strip")!;
    // 800 px ↔ 16 s → 50 px per second. Picking a trim point you can't
    // see the frame for is guesswork, so every handle move seeks.
    pointer(outHandle, "pointerdown", 700);
    pointer(strip, "pointermove", 400);
    pointer(strip, "pointerup", 400);
    expect(seeks).toEqual([14, 8, 8]);
  });

  test("the trim seek follows the clamped handle, not the raw pointer", () => {
    const seeks: number[] = [];
    const { el } = render({
      range: { start: 8, end: 16 },
      onSeek: (sec) => seeks.push(sec)
    });
    const outHandle = el.querySelector('[data-testid="video-timeline-out"]')!;
    const strip = el.querySelector(".vtl__strip")!;
    // Dragged well past the in-handle: the out edge stops at the
    // MIN_RANGE_SEC gap, and the preview must show THAT frame — not
    // the 2 s the pointer is actually over.
    pointer(outHandle, "pointerdown", 700);
    pointer(strip, "pointermove", 100);
    expect(seeks.at(-1)).toBe(8.1);
  });

  test("Escape mid-drag restores the range and does not reach other handlers", () => {
    const changes: Array<{ range: VideoRange; commit: boolean }> = [];
    const seeks: number[] = [];
    // Stands in for the Library's focus-mode Esc ("close the editor"),
    // which listens on window in the bubble phase.
    let editorClosed = 0;
    const closeEditor = (): void => {
      editorClosed += 1;
    };
    window.addEventListener("keydown", closeEditor);
    try {
      const { el } = render({
        range: { start: 2, end: 12 },
        onSeek: (sec) => seeks.push(sec),
        onRangeChange: (range, commit) => changes.push({ range, commit })
      });
      const outHandle = el.querySelector('[data-testid="video-timeline-out"]')!;
      const strip = el.querySelector(".vtl__strip")!;

      pointer(outHandle, "pointerdown", 600);
      pointer(strip, "pointermove", 300);
      expect(changes.at(-1)).toEqual({ range: { start: 2, end: 6 }, commit: false });

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      });

      // Range is back where the drag started, committed so the caller
      // settles rather than sitting in a permanent "dragging" state.
      expect(changes.at(-1)).toEqual({ range: { start: 2, end: 12 }, commit: true });
      expect(seeks.at(-1)).toBe(12);
      // The editor must NOT close — mid-drag, Esc means undo the drag.
      expect(editorClosed).toBe(0);
      // Drag is over: a later pointerup is inert, and the tooltip is gone.
      expect(el.querySelector(".vtl__tip")).toBeNull();
      pointer(strip, "pointerup", 100);
      expect(changes.at(-1)).toEqual({ range: { start: 2, end: 12 }, commit: true });
    } finally {
      window.removeEventListener("keydown", closeEditor);
    }
  });

  test("Escape with no drag in flight leaves other handlers alone", () => {
    let editorClosed = 0;
    const closeEditor = (): void => {
      editorClosed += 1;
    };
    window.addEventListener("keydown", closeEditor);
    try {
      render({ range: { start: 2, end: 12 } });
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      });
      expect(editorClosed).toBe(1);
    } finally {
      window.removeEventListener("keydown", closeEditor);
    }
  });

  test("reports drag start / end so the caller can pause playback", () => {
    const events: boolean[] = [];
    const { el } = render({
      range: { start: 0, end: 16 },
      onInteractingChange: (interacting) => events.push(interacting)
    });
    const inHandle = el.querySelector('[data-testid="video-timeline-in"]')!;
    const strip = el.querySelector(".vtl__strip")!;

    pointer(inHandle, "pointerdown", 100);
    expect(events).toEqual([true]);
    pointer(strip, "pointermove", 200);
    expect(events).toEqual([true]);
    pointer(strip, "pointerup", 200);
    expect(events).toEqual([true, false]);
  });

  test("the out-handle can't cross the in-handle (keeps the minimum gap)", () => {
    const changes: Array<{ range: VideoRange; commit: boolean }> = [];
    const { el } = render({
      range: { start: 8, end: 16 },
      onRangeChange: (range, commit) => changes.push({ range, commit })
    });
    const outHandle = el.querySelector('[data-testid="video-timeline-out"]')!;
    const strip = el.querySelector(".vtl__strip")!;
    pointer(outHandle, "pointerdown", 700);
    pointer(strip, "pointermove", 100); // 2 s — before the in point
    pointer(strip, "pointerup", 100);
    expect(changes.at(-1)).toEqual({ range: { start: 8, end: 8.1 }, commit: true });
  });

  test("pressing on the strip body scrubs (onSeek), not the range", () => {
    const seeks: number[] = [];
    const changes: unknown[] = [];
    const { el } = render({
      range: { start: 0, end: 16 },
      onSeek: (sec) => seeks.push(sec),
      onRangeChange: (r, c) => changes.push([r, c])
    });
    const strip = el.querySelector(".vtl__strip")!;
    pointer(strip, "pointerdown", 400);
    pointer(strip, "pointerup", 400);
    expect(seeks).toEqual([8, 8]);
    expect(changes).toEqual([]);
    // Tooltip shows the timecode while dragging, gone after release.
    expect(el.querySelector(".vtl__tip")).toBeNull();
  });

  test("labels + Full clip chip follow the range", () => {
    const changes: Array<{ range: VideoRange; commit: boolean }> = [];
    const { el, rerender } = render({
      range: { start: 0, end: 16 },
      onRangeChange: (range, commit) => changes.push({ range, commit })
    });
    const label = (): string | null | undefined =>
      el.querySelector('[data-testid="video-timeline-trim-label"]')?.textContent;
    const chip = (): HTMLButtonElement =>
      el.querySelector('[data-testid="video-timeline-full-clip"]') as HTMLButtonElement;
    expect(label()).toBe("FULL CLIP · 0:16.0");
    expect(chip().disabled).toBe(true);

    rerender({
      range: { start: 3.4, end: 11.2 },
      onRangeChange: (range, commit) => changes.push({ range, commit })
    });
    expect(label()).toBe("TRIM 0:03.4 – 0:11.2 · 7.8 s");
    expect(chip().disabled).toBe(false);
    act(() => chip().click());
    expect(changes.at(-1)).toEqual({ range: { start: 0, end: 16 }, commit: true });
  });

  test("compact variant: no playhead / waveform / ticks; strip body does not scrub", () => {
    const seeks: number[] = [];
    const { el } = render({ range: { start: 0, end: 16 }, compact: true });
    expect(el.querySelector('[data-testid="video-timeline-compact"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="video-timeline-playhead"]')).toBeNull();
    expect(el.querySelector(".vtl__wave")).toBeNull();
    expect(el.querySelector(".vtl__ticks")).toBeNull();
    expect(el.querySelector('[data-testid="video-timeline-in"]')).not.toBeNull();
    const strip = el.querySelector(".vtl__strip")!;
    pointer(strip, "pointerdown", 400);
    pointer(strip, "pointerup", 400);
    expect(seeks).toEqual([]);
    expect(el.querySelector(".vtl__tip")).toBeNull();
  });

  test("full variant renders the filmstrip image + ticks + playhead position", () => {
    const { el } = render({
      range: { start: 0, end: 16 },
      currentTime: 4,
      frames: {
        url: "pwrsnap-cache://v/cap/frames-n24-w96.jpg",
        frameCount: 24,
        frameWidth: 96,
        frameHeight: 54
      }
    });
    const img = el.querySelector(".vtl__film-img") as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("pwrsnap-cache://v/cap/frames-n24-w96.jpg");
    expect(el.querySelectorAll(".vtl__tick.is-major").length).toBe(4); // 0,5,10,15
    const playhead = el.querySelector('[data-testid="video-timeline-playhead"]') as HTMLElement;
    // `transform`, not `left`: the head is written straight to the node
    // at up to 60 Hz, so it must stay off the layout path.
    expect(playhead.style.transform).toBe("translateX(200px)");
  });

  test("a playhead source moves the head without re-rendering, and keeps aria in step", () => {
    const source = createPlayheadSource(0);
    const { el } = render({ range: { start: 0, end: 16 }, currentTime: 0, playhead: source });
    const head = el.querySelector('[data-testid="video-timeline-playhead"]') as HTMLElement;
    const strip = el.querySelector(".vtl__strip") as HTMLElement;
    expect(head.style.transform).toBe("translateX(0px)");

    // No `act`: the whole point is that this never touches React state.
    source.set(4);
    expect(head.style.transform).toBe("translateX(200px)");
    expect(strip.getAttribute("aria-valuenow")).toBe("4");
    expect(strip.getAttribute("aria-valuetext")).toBe("0:04.0");

    source.set(8);
    expect(head.style.transform).toBe("translateX(400px)");
    expect(strip.getAttribute("aria-valuetext")).toBe("0:08.0");
  });

  test("head placement quantizes to device pixels and skips pixel-identical writes", () => {
    // The rAF loop publishes at DISPLAY refresh while the head advances
    // at strip-width / duration, so most published positions render
    // identically. Each redundant write cost a full compositor commit +
    // draw + swap; on a 120 Hz display with a 178 s clip that was ~110
    // wasted swaps a second. See VideoTimeline.tsx `placePlayhead`.
    const dpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    try {
      const source = createPlayheadSource(0);
      const { el } = render({ range: { start: 0, end: 16 }, currentTime: 0, playhead: source });
      const head = el.querySelector('[data-testid="video-timeline-playhead"]') as HTMLElement;
      // 800 px strip / 16 s = 50 px/s, so a device pixel (0.5 CSS px at
      // dpr 2) is 0.01 s of clip.
      const writes: string[] = [];
      const proxy = new Proxy(head.style, {
        set(target, prop, value: string) {
          if (prop === "transform") writes.push(value);
          return Reflect.set(target, prop, value);
        }
      });
      Object.defineProperty(head, "style", { configurable: true, value: proxy });

      source.set(0.004); // 0.2 CSS px -> device px 0 -> already placed
      expect(writes).toEqual([]);

      source.set(0.008); // 0.4 CSS px -> device px 1 -> 0.5 CSS px
      expect(writes).toEqual(["translateX(0.5px)"]);

      source.set(0.012); // 0.6 CSS px -> device px 1 again -> no write
      expect(writes).toEqual(["translateX(0.5px)"]);

      source.set(0.02); // 1.0 CSS px -> device px 2
      expect(writes).toEqual(["translateX(0.5px)", "translateX(1px)"]);
    } finally {
      if (dpr === undefined) {
        delete (window as unknown as Record<string, unknown>).devicePixelRatio;
      } else {
        Object.defineProperty(window, "devicePixelRatio", dpr);
      }
    }
  });

  test("a re-render from something else does not snap the head back to `currentTime`", () => {
    const source = createPlayheadSource(0);
    const { el, rerender } = render({
      range: { start: 0, end: 16 },
      currentTime: 0,
      playhead: source
    });
    const head = el.querySelector('[data-testid="video-timeline-playhead"]') as HTMLElement;
    source.set(8);
    expect(head.style.transform).toBe("translateX(400px)");
    // `currentTime` is the DISCRETE head and lags during playback; a
    // range change must not drag the live head back to it.
    rerender({ range: { start: 2, end: 16 }, currentTime: 0, playhead: source });
    expect(head.style.transform).toBe("translateX(400px)");
  });
});
