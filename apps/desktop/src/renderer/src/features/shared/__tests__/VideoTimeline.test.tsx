// Component tests for the trim timeline: handle drags report
// `commit=false` while moving and `commit=true` on release, the strip
// body scrubs (seek), the scrim / labels follow the range, and the
// compact variant hides playhead + waveform. jsdom has no layout, so
// the strip's bounding rect is stubbed to 800 px.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { VideoRange } from "@pwrsnap/shared";
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
    expect(playhead.style.left).toBe("200px");
  });
});
