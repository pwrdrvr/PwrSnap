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
    expect(playhead.style.left).toBe("200px");
  });
});
