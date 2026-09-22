// Component tests for the trim timeline: handle drags report
// `commit=false` while moving and `commit=true` on release, the strip
// body scrubs (seek), the scrim / labels follow the range, and the
// compact variant hides playhead + waveform. jsdom has no layout, so
// the strip is stubbed to 800 px twice over: `clientWidth`, which is
// what SIZES the handles / ticks / playhead, and the bounding rect,
// which is what MAPS pointer coordinates.

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
let clientWidthSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  clientWidthSpy = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(800);
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
  clientWidthSpy?.mockRestore();
  clientWidthSpy = null;
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

function restoreDpr(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    delete (window as unknown as Record<string, unknown>).devicePixelRatio;
    return;
  }
  Object.defineProperty(window, "devicePixelRatio", descriptor);
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

  // Regression: the strip is SIZED from a layout measure, never from
  // `getBoundingClientRect()`. In the Library the timeline mounts
  // inside `.psl__focus`, whose `psl-focus-in` entrance animates
  // `scale(0.985)` -> `scale(1)`, and the rect is post-transform — so
  // a rect-sized strip came up ~1.5% short and, because a
  // ResizeObserver only reports layout boxes, never corrected. The
  // out handle, the ticks and the playhead sat ~14px inside the right
  // edge and the right scrim dimmed that band at FULL CLIP.
  //
  // Standing in for the entrance transform: the rect reads 788 (800 x
  // 0.985) while the layout box is still 800. Everything sized must
  // follow the 800.
  test("sizes off the layout box, not a transform-polluted rect", () => {
    rectSpy!.mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 788,
          bottom: 80,
          width: 788,
          height: 80,
          toJSON: () => ({})
        }) as DOMRect
    );
    const widths: number[] = [];
    const { el } = render({
      range: { start: 0, end: 16 },
      durationSec: 16,
      currentTime: 16,
      onWidthChange: (w) => widths.push(w)
    });

    expect(widths.at(-1)).toBe(800);

    // All four consumers of `width`, because the bug hit all four and a
    // partial fix would leave the ruler describing a different space
    // than the strip. Each reads 788 (or a proportional short) when the
    // measure regresses.
    //
    // 1. The out handle's own 8px sit just inside the right edge...
    const outHandle = el.querySelector('[data-testid="video-timeline-out"]') as HTMLElement;
    expect(outHandle.style.left).toBe("792px");
    // 2. ...and the right scrim collapses to zero rather than dimming a
    //    band of live filmstrip at FULL CLIP.
    const rightScrim = el.querySelector(".vtl__scrim.is-right") as HTMLElement;
    expect(rightScrim.style.left).toBe("800px");
    // 3. The last tick lands ON the right edge, not short of it.
    const ticks = el.querySelectorAll<HTMLElement>(".vtl__tick");
    expect(ticks[ticks.length - 1]?.style.left).toBe("800px");
    // 4. The playhead at the end of the clip reaches it.
    const head = el.querySelector('[data-testid="video-timeline-playhead"]') as HTMLElement;
    expect(head.style.transform).toBe("translateX(800px)");

    // The control, and the reason this reads as "the RIGHT handle is
    // broken": `inX` is `secToPx(0, …)`, which is 0 at every width
    // including the wrong one. This assertion cannot fail — it is here
    // to say so, not to cover anything.
    const inHandle = el.querySelector('[data-testid="video-timeline-in"]') as HTMLElement;
    expect(inHandle.style.left).toBe("0px");
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

  // The drag tooltip used to render inside `.vtl__strip`, which carries
  // `overflow: hidden` for its border-radius — so a drag that reached
  // either end had the tip's trailing digits sliced off at the strip
  // edge ("0:01" where the value was "0:01.4"). Two halves to the fix
  // and both are load-bearing: the tip has to sit OUTSIDE the clipping
  // box, and it has to stay inside the strip once it is free of it,
  // because the Library's `.psl__stage-wrap` clips at the stage edge and
  // would take over where the strip left off.
  describe("drag tooltip", () => {
    // jsdom lays nothing out, so `offsetWidth` is 0 and the clamp is a
    // no-op unless the tip's width is stubbed. 44px is about what the
    // real `0:01.4` box measures at 10px mono + 6px padding + border.
    const TIP_W = 44;
    let tipSpy: ReturnType<typeof vi.spyOn> | null = null;
    function stubTipWidth(px = TIP_W): void {
      tipSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(px);
    }
    afterEach(() => {
      tipSpy?.mockRestore();
      tipSpy = null;
    });

    /** Press the out handle at `clientX` and return the live tip. The
     *  handle, not the strip body: that is the gesture in the report,
     *  and it needs no `onSeek` to arm. `drag.sec` is the RAW pointer
     *  time, so the tip reads the edge of the strip even where
     *  `clampRange` holds the range back. */
    function tipDuring(clientX: number): HTMLElement {
      const { el } = render({ range: { start: 0, end: 16 } });
      pointer(el.querySelector('[data-testid="video-timeline-out"]')!, "pointerdown", clientX);
      return el.querySelector('[data-testid="video-timeline-tip"]') as HTMLElement;
    }

    test("renders outside the strip, so `overflow: hidden` cannot clip it", () => {
      stubTipWidth();
      const tip = tipDuring(400);
      expect(tip).not.toBeNull();
      expect(tip.closest(".vtl__strip")).toBeNull();
      expect(tip.closest(".vtl__strip-wrap")).not.toBeNull();
    });

    test("is centred on the pointer away from the edges", () => {
      stubTipWidth();
      // 800px over 16s, pressed at 400px → 8s, dead centre. jsdom lays
      // nothing out so `clientLeft` is 0 here; the border conversion is
      // covered by the test below.
      expect(tipDuring(400).style.left).toBe("400px");
    });

    // The tip's containing block is the WRAPPER, whose padding box is
    // the strip's BORDER box — one border wider on each side than the
    // padding box `tooltipX` is measured in. Without adding it back the
    // tip drifts a border off the pointer, which is the same class of
    // mistake as the ruler's inline margin.
    test("converts out of the strip's padding box into the wrapper's", () => {
      stubTipWidth();
      const borderSpy = vi
        .spyOn(Element.prototype, "clientLeft", "get")
        .mockReturnValue(3);
      try {
        expect(tipDuring(400).style.left).toBe("403px");
      } finally {
        borderSpy.mockRestore();
      }
    });

    test("stops at the right edge instead of hanging off it", () => {
      stubTipWidth();
      // Pressed at the far right, `translateX(-50%)` would put half the
      // box past 800 — the case in the bug report.
      expect(tipDuring(800).style.left).toBe(`${800 - TIP_W / 2}px`);
    });

    test("stops at the left edge too", () => {
      stubTipWidth();
      expect(tipDuring(0).style.left).toBe(`${TIP_W / 2}px`);
    });

    test("a strip narrower than the tip still yields a usable position", () => {
      // Lower bound (half the tip) above upper bound (width - half):
      // the clamp must not invert and put the tip off the far end.
      stubTipWidth(900);
      const left = Number(tipDuring(400).style.left.replace("px", ""));
      expect(Number.isFinite(left)).toBe(true);
      expect(left).toBe(450);
    });
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
      restoreDpr(dpr);
    }
  });

  test("the skip still fires at a fractional devicePixelRatio", () => {
    // Windows at 150% scaling. Device pixels land on thirds, so the
    // written string is a long repeating decimal that Blink re-
    // serializes to something shorter. Comparing what we wrote against
    // `el.style.transform` would therefore never match and the skip
    // would silently stop skipping — hence the numeric comparison.
    const dpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
    try {
      const source = createPlayheadSource(0);
      const { el } = render({ range: { start: 0, end: 16 }, currentTime: 0, playhead: source });
      const head = el.querySelector('[data-testid="video-timeline-playhead"]') as HTMLElement;
      const writes: string[] = [];
      const proxy = new Proxy(head.style, {
        set(target, prop, value: string) {
          if (prop === "transform") writes.push(value);
          return Reflect.set(target, prop, value);
        }
      });
      Object.defineProperty(head, "style", { configurable: true, value: proxy });

      // 50 px/s; a device pixel is 1/1.5 CSS px = 0.0133… s of clip.
      source.set(0.014); // 0.7 CSS px -> device px 1
      expect(writes).toEqual(["translateX(0.6666666666666666px)"]);

      // Three more publishes that all round to the same device pixel.
      source.set(0.015);
      source.set(0.016);
      source.set(0.017);
      expect(writes).toHaveLength(1);

      source.set(0.028); // 1.4 CSS px -> device px 2
      expect(writes).toHaveLength(2);
    } finally {
      restoreDpr(dpr);
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

describe("VideoTimeline — splits and cuts", () => {
  // 800 px ↔ 16 s → 50 px per second throughout.
  type Change = { segments: readonly VideoRange[]; commit: boolean };

  function editable(
    segments: readonly VideoRange[],
    extra: Partial<VideoTimelineProps> = {}
  ): { el: HTMLDivElement; changes: Change[]; seeks: number[] } {
    const changes: Change[] = [];
    const seeks: number[] = [];
    const first = segments[0]!;
    const last = segments[segments.length - 1]!;
    const { el } = render({
      range: { start: first.start, end: last.end },
      segments,
      onSegmentsChange: (next, commit) => changes.push({ segments: next, commit }),
      onSeek: (sec) => seeks.push(sec),
      ...extra
    });
    return { el, changes, seeks };
  }

  const q = (el: Element, id: string): HTMLElement | null =>
    el.querySelector(`[data-testid="${id}"]`);

  test("an interior cut is drawn in place and the foot reports the kept length", () => {
    const { el } = editable([
      { start: 0, end: 4 },
      { start: 9, end: 16 }
    ]);
    const cut = q(el, "video-timeline-cut")!;
    expect(cut.style.left).toBe("200px");
    expect(cut.style.width).toBe("250px");
    expect(q(el, "video-timeline-trim-label")!.textContent).toBe("2 PARTS · 11 s OF 0:16.0");
    // Both sides of the cut get an edge handle; the hint is for first-timers.
    expect(q(el, "video-timeline-cut-in")).not.toBeNull();
    expect(q(el, "video-timeline-cut-out")).not.toBeNull();
    expect(q(el, "video-timeline-hint")).toBeNull();
  });

  test("hovering a kept part offers Cut, hovering a cut offers Keep", () => {
    const { el, changes } = editable([
      { start: 0, end: 4 },
      { start: 9, end: 16 }
    ]);
    const strip = el.querySelector(".vtl__strip")!;

    pointer(strip, "pointermove", 100);
    const cutChip = q(el, "video-timeline-piece-chip")!;
    expect(cutChip.textContent).toBe("Cut");
    act(() => cutChip.click());
    expect(changes).toEqual([{ segments: [{ start: 9, end: 16 }], commit: true }]);

    pointer(strip, "pointermove", 300);
    const keepChip = q(el, "video-timeline-piece-chip")!;
    expect(keepChip.textContent).toBe("Keep");
    act(() => keepChip.click());
    // Restored as its own part, so both old boundaries survive as splits.
    expect(changes[1]).toEqual({
      segments: [
        { start: 0, end: 4 },
        { start: 4, end: 9 },
        { start: 9, end: 16 }
      ],
      commit: true
    });
  });

  test("no Cut chip when there is only one part to keep, and none over the trimmed ends", () => {
    const { el } = editable([{ start: 2, end: 14 }]);
    const strip = el.querySelector(".vtl__strip")!;
    pointer(strip, "pointermove", 400);
    expect(q(el, "video-timeline-piece-chip")).toBeNull();
    pointer(strip, "pointermove", 20);
    expect(q(el, "video-timeline-piece-chip")).toBeNull();
    expect(q(el, "video-timeline-hint")!.textContent).toBe("S split · X cut");
  });

  test("a split moves only when dragged, and double-click removes it", () => {
    const { el, changes, seeks } = editable([
      { start: 0, end: 8 },
      { start: 8, end: 16 }
    ]);
    const strip = el.querySelector(".vtl__strip")!;
    const split = q(el, "video-timeline-split")!;
    expect(q(el, "video-timeline-trim-label")!.textContent).toBe("FULL CLIP · 0:16.0 · 1 SPLIT");

    // A press without movement — half of a double-click — changes nothing.
    pointer(split, "pointerdown", 403);
    pointer(strip, "pointerup", 403);
    expect(changes).toEqual([]);

    pointer(split, "pointerdown", 400);
    pointer(strip, "pointermove", 450);
    pointer(strip, "pointerup", 450);
    expect(changes).toEqual([
      { segments: [{ start: 0, end: 9 }, { start: 9, end: 16 }], commit: false },
      { segments: [{ start: 0, end: 9 }, { start: 9, end: 16 }], commit: true }
    ]);
    expect(seeks.at(-1)).toBe(9);

    act(() => {
      split.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(changes.at(-1)).toEqual({ segments: [{ start: 0, end: 16 }], commit: true });
  });

  test("dragging a cut's edge onto the other side undoes the cut on release", () => {
    const { el, changes } = editable([
      { start: 0, end: 4 },
      { start: 9, end: 16 }
    ]);
    const strip = el.querySelector(".vtl__strip")!;
    pointer(q(el, "video-timeline-cut-in")!, "pointerdown", 197);
    pointer(strip, "pointermove", 300);
    // 447 px is 8.94 s — inside the snap, so it lands exactly on 9.
    pointer(strip, "pointermove", 447);
    pointer(strip, "pointerup", 447);
    expect(changes[0]).toEqual({
      segments: [{ start: 0, end: 6 }, { start: 9, end: 16 }],
      commit: false
    });
    // Mid-drag the parts stay separate, so dragging back reopens the cut…
    expect(changes.at(-2)).toEqual({
      segments: [{ start: 0, end: 9 }, { start: 9, end: 16 }],
      commit: false
    });
    // …and on release they are one part again, not a leftover split.
    expect(changes.at(-1)).toEqual({ segments: [{ start: 0, end: 16 }], commit: true });
  });

  test("the cut's far edge undoes it the same way", () => {
    const { el, changes } = editable([
      { start: 0, end: 4 },
      { start: 9, end: 16 }
    ]);
    const strip = el.querySelector(".vtl__strip")!;
    pointer(q(el, "video-timeline-cut-out")!, "pointerdown", 450);
    pointer(strip, "pointermove", 203);
    pointer(strip, "pointerup", 203);
    expect(changes.at(-1)).toEqual({ segments: [{ start: 0, end: 16 }], commit: true });
  });

  test("an edge released short of its neighbour keeps the cut", () => {
    const { el, changes } = editable([
      { start: 0, end: 4 },
      { start: 9, end: 16 }
    ]);
    const strip = el.querySelector(".vtl__strip")!;
    pointer(q(el, "video-timeline-cut-out")!, "pointerdown", 450);
    pointer(strip, "pointermove", 300);
    pointer(strip, "pointerup", 300);
    expect(changes.at(-1)).toEqual({
      segments: [{ start: 0, end: 4 }, { start: 6, end: 16 }],
      commit: true
    });
  });

  test("Escape mid-drag puts the parts back", () => {
    const segments = [
      { start: 0, end: 8 },
      { start: 8, end: 16 }
    ];
    const { el, changes } = editable(segments);
    const strip = el.querySelector(".vtl__strip")!;
    pointer(q(el, "video-timeline-split")!, "pointerdown", 400);
    pointer(strip, "pointermove", 600);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(changes.at(-1)).toEqual({ segments, commit: true });
  });

  test("Full clip resets the parts, not just the outer handles", () => {
    const ranges: VideoRange[] = [];
    const { el, changes } = editable(
      [
        { start: 0, end: 4 },
        { start: 9, end: 16 }
      ],
      { onRangeChange: (range) => ranges.push(range) }
    );
    act(() => q(el, "video-timeline-full-clip")!.click());
    expect(changes).toEqual([{ segments: [{ start: 0, end: 16 }], commit: true }]);
    expect(ranges).toEqual([]);
  });

  test("the activity lane draws the levels, and Cut idle removes the still stretch", () => {
    // 5 Hz × 16 s: busy for 2 s, still for 8 s, busy for 6 s.
    const magnitudes = [
      ...Array.from({ length: 10 }, () => 255),
      ...Array.from({ length: 40 }, () => 0),
      ...Array.from({ length: 30 }, () => 255)
    ];
    const { el, changes } = editable([{ start: 0, end: 16 }], {
      activity: { sampleHz: 5, magnitudes }
    });
    const lane = q(el, "video-timeline-activity")!;
    expect(lane.querySelector(".vtl__act-l3")).not.toBeNull();
    expect(lane.querySelector(".vtl__act-idle")).not.toBeNull();

    const chip = q(el, "video-timeline-cut-idle")!;
    // Still from 2 s to 10 s, less half a second of padding either side.
    expect(chip.textContent).toBe("Cut idle −7 s");
    act(() => {
      chip.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    const preview = q(el, "video-timeline-idle-preview")!;
    expect(preview.style.left).toBe("125px");
    expect(preview.style.width).toBe("350px");

    act(() => chip.click());
    expect(changes).toEqual([
      { segments: [{ start: 0, end: 2.5 }, { start: 9.5, end: 16 }], commit: true }
    ]);
  });

  test("a still-loading track draws an empty lane and offers no Cut idle", () => {
    const { el } = editable([{ start: 0, end: 16 }], { activity: null });
    expect(q(el, "video-timeline-activity")!.classList.contains("is-loading")).toBe(true);
    expect(q(el, "video-timeline-cut-idle")).toBeNull();
  });

  test("compact: cuts are drawn but not editable", () => {
    const { el } = render({
      compact: true,
      range: { start: 0, end: 16 },
      segments: [
        { start: 0, end: 4 },
        { start: 9, end: 16 }
      ],
      onSegmentsChange: () => undefined
    });
    expect(q(el, "video-timeline-cut")).not.toBeNull();
    expect(q(el, "video-timeline-cut-in")).toBeNull();
    expect(q(el, "video-timeline-hint")).toBeNull();
    pointer(el.querySelector(".vtl__strip")!, "pointermove", 100);
    expect(q(el, "video-timeline-piece-chip")).toBeNull();
  });
});
