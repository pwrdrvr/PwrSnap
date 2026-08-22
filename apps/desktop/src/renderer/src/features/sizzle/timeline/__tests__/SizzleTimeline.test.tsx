// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, SizzleScene, SizzleSequenceBeat, SizzleWordTiming } from "@pwrsnap/shared";
import { SizzleTimeline, type SizzleTimelineProps } from "../SizzleTimeline";
import { buildTimelineModel, type TimelineModel } from "../timeline-model";

vi.mock("wavesurfer.js", () => ({
  default: { create: () => ({ loadBlob: () => Promise.resolve(), destroy: () => undefined }) }
}));

// jsdom has no layout. The timeline measures its canvas with
// getBoundingClientRect, so give it a fixed 1000 px strip.
const STRIP_PX = 1000;
beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    const width =
      this.classList.contains("szt__scroll") || this.classList.contains("szt__lanes") ? STRIP_PX : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 0, width, height: 0, toJSON: () => ({}) } as DOMRect;
  };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

const beat = (id: string, patch: Partial<SizzleSequenceBeat> = {}): SizzleSequenceBeat => ({
  id,
  captureId: `cap_${id}`,
  timing: { kind: "auto" },
  mediaTrim: null,
  transition: "cut",
  videoFit: "smart-fit",
  ...patch
});
const sequence = (id: string, narration: string, beats: SizzleSequenceBeat[], patch: Partial<SizzleScene> = {}): SizzleScene => ({
  id,
  kind: "sequence",
  captureId: beats[0]?.captureId ?? "",
  scriptLine: narration,
  narration,
  beats,
  durationOverrideSec: null,
  mediaTrim: null,
  audioSource: "voiceover",
  transition: "crossfade",
  ...patch
});
const SCRIPT = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen";
const WORDS: SizzleWordTiming[] = SCRIPT.split(" ").map((word, index) => ({
  index, word, normalized: word, startSec: index * 0.5, endSec: index * 0.5 + 0.4
}));
const imageCapture = (id: string): CaptureRecord =>
  ({
    id,
    kind: "image",
    captured_at: "2026-08-22T00:00:00.000Z",
    legacy_src_path: null,
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: 2,
    bundle_edits_version: 0,
    width_px: 100,
    height_px: 100,
    device_pixel_ratio: 1,
    byte_size: 1,
    sha256: id,
    source_app_bundle_id: null,
    source_app_name: `App ${id}`,
    edits_version: 0,
    has_alpha: false,
    deleted_at: null
  }) as unknown as CaptureRecord;

function baseProps(model: TimelineModel): SizzleTimelineProps {
  return {
    model,
    captureMap: new Map(),
    audioBlobs: {},
    playheadSec: 0,
    onScrub: () => undefined,
    selectedClipId: null,
    onSelectClip: () => undefined
  };
}

async function render(props: Partial<SizzleTimelineProps> & { model: TimelineModel }): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const full: SizzleTimelineProps = { ...baseProps(props.model), ...props };
  await act(async () => {
    root?.render(createElement(SizzleTimeline, full));
  });
  return container;
}

const resolvedModel = (): TimelineModel =>
  buildTimelineModel({
    scenes: [
      sequence("s1", SCRIPT, [
        beat("a"),
        beat("b", { timing: { kind: "phrase", phrase: "nine", occurrence: 1, offsetSec: 0, durationSec: null } }),
        beat("c")
      ])
    ],
    sourceFor: () => ({ words: WORDS, context: { capture: null, narrationDurationSec: 8 } })
  });

const estimatedModel = (): TimelineModel =>
  buildTimelineModel({
    scenes: [sequence("s1", SCRIPT, [beat("a"), beat("b")])],
    sourceFor: () => ({ words: null, context: { capture: null } })
  });

describe("SizzleTimeline", () => {
  test("lays clips out proportionally at fit-to-width: width is the clip's share of the reel", async () => {
    const el = await render({ model: resolvedModel() });
    // 8 s over 1000 px = 125 px/s. Clip a: 0–4 s → 500 px; b: 4–6 s → 250; c: 6–8 → 250.
    const a = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-clip-a"]')!;
    const b = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-clip-b"]')!;
    expect(a.style.left).toBe("0px");
    expect(parseFloat(a.style.width)).toBeCloseTo(499, 0);
    expect(parseFloat(b.style.left)).toBeCloseTo(500, 0);
    expect(parseFloat(b.style.width)).toBeCloseTo(249, 0);
    expect(a.dataset.detail).toBe("full");
    // The anchored clip shows its pin; the auto clips do not.
    expect(b.querySelector(".szt__pin")).not.toBeNull();
    expect(a.querySelector(".szt__pin")).toBeNull();
    // Meta reads the exact total with no tilde.
    expect(el.querySelector('[data-testid="sizzle-timeline-meta"]')?.textContent).toContain("0:08.0");
    expect(el.querySelector('[data-testid="sizzle-timeline-meta"]')?.textContent).not.toContain("~");
    expect(el.querySelector('[data-testid="sizzle-timeline-estimated-0"]')).toBeNull();
  });

  test("an estimated scene is hatched, dashed, and carries ~ on every length", async () => {
    const el = await render({ model: estimatedModel() });
    expect(el.querySelector('[data-testid="sizzle-timeline-estimated-0"]')).not.toBeNull();
    const region = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-scene-0"]')!;
    expect(region.dataset.exactness).toBe("estimated");
    expect(region.textContent).toContain("~");
    expect(region.textContent).toContain("est.");
    const clip = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-clip-a"]')!;
    expect(clip.classList.contains("is-est")).toBe(true);
    expect(clip.textContent).toContain("~");
    expect(el.querySelector('[data-testid="sizzle-timeline-meta"]')?.textContent).toContain("~");
    // No waveform — the idle baseline instead.
    expect(el.querySelector('[data-testid="sizzle-timeline-wave-idle-0"]')).not.toBeNull();
  });

  test("80 clips at fit are bare ticks; at 4× they grow into thumbnails and the strip scrolls", async () => {
    const model = buildTimelineModel({
      scenes: [sequence("s1", SCRIPT, Array.from({ length: 80 }, (_, i) => beat(`b${i}`)))],
      sourceFor: () => ({ words: WORDS, context: { capture: null, narrationDurationSec: 8 } })
    });
    const el = await render({ model });
    // 8 s / 80 clips at 125 px/s = 12.5 px each → tick.
    const ticks = el.querySelectorAll('[data-detail="tick"]');
    expect(ticks.length).toBe(80);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-timeline-zoom-4"]')!.click();
    });
    // 4× = 160 px/s → 16 px per clip: still too narrow for a picture at this density…
    expect(el.querySelectorAll('[data-detail="tick"]').length).toBe(80);
    // …but the lanes are now wider than the strip, so the axis scrolls.
    const lanes = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-lanes"]')!;
    expect(parseFloat(lanes.style.width)).toBeGreaterThan(STRIP_PX);
    expect(el.querySelector('[data-testid="sizzle-timeline-meta"]')?.textContent).toContain("160 px/s");
  });

  test("pressing on the track scrubs: onScrub gets the time under the pointer, then follows the drag", async () => {
    const onScrub = vi.fn();
    const el = await render({ model: resolvedModel(), onScrub });
    const lanes = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-lanes"]')!;
    await act(async () => {
      lanes.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 250 }));
    });
    expect(onScrub).toHaveBeenLastCalledWith(2); // 250 px / 125 px/s
    await act(async () => {
      lanes.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 750 }));
    });
    expect(onScrub).toHaveBeenLastCalledWith(6);
    await act(async () => {
      lanes.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 875 }));
    });
    expect(onScrub).toHaveBeenLastCalledWith(7);
  });

  test("clicking a clip selects it (and does not scrub); bare track clears the selection", async () => {
    const onScrub = vi.fn();
    const onSelectClip = vi.fn();
    const el = await render({
      model: resolvedModel(),
      onScrub,
      onSelectClip,
      captureMap: new Map([["cap_a", imageCapture("cap_a")]])
    });
    const clip = el.querySelector<HTMLButtonElement>('[data-testid="sizzle-timeline-clip-b"]')!;
    await act(async () => {
      clip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 2, clientX: 510 }));
      clip.click();
    });
    expect(onScrub).not.toHaveBeenCalled();
    expect(onSelectClip).toHaveBeenCalledWith(expect.objectContaining({ beatId: "b" }));
    // The image capture's clip shows a cacheUrl poster, never a <video>.
    expect(el.querySelector('[data-testid="sizzle-timeline-clip-a"] img')).not.toBeNull();
    expect(el.querySelectorAll("video").length).toBe(0);
    const lanes = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-lanes"]')!;
    await act(async () => {
      lanes.click();
    });
    expect(onSelectClip).toHaveBeenLastCalledWith(null);
  });

  test("the playhead sits at the project time and the scene boundary carries the transition pill", async () => {
    const model = buildTimelineModel({
      scenes: [
        sequence("s1", SCRIPT, [beat("a")]),
        sequence("s2", SCRIPT, [beat("b")], { transition: { type: "dip-black", durationSec: 0.5 } })
      ],
      sourceFor: () => ({ words: WORDS, context: { capture: null, narrationDurationSec: 8 } })
    });
    // total = 8 + 8 − 0.5 = 15.5 s over 1000 px.
    const el = await render({ model, playheadSec: 7.75 });
    const head = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-playhead"]')!;
    expect(head.style.transform).toBe("translateX(500px)");
    expect(head.textContent).toBe("0:07.7");
    expect(head.classList.contains("is-flip")).toBe(false);
    // At the end of the reel the timecode tag flips to the left of the
    // line so it cannot overflow the lanes (and widen the scroll area).
    await act(async () => {
      root?.render(createElement(SizzleTimeline, { ...baseProps(model), playheadSec: 15.5 }));
    });
    const headAtEnd = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-playhead"]')!;
    expect(headAtEnd.style.transform).toBe("translateX(1000px)");
    expect(headAtEnd.classList.contains("is-flip")).toBe(true);
    const pill = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-transition-1"]')!;
    expect(pill.textContent).toContain("dip black");
    expect(pill.textContent).toContain("0.5 s");
    expect(pill.classList.contains("is-fade")).toBe(true);
  });
});

describe("SizzleTimeline — drag to move / retime (plan §4.4)", () => {
  const grip = (el: HTMLElement, beatId: string): HTMLElement =>
    el.querySelector<HTMLElement>(`[data-testid="sizzle-timeline-grip-${beatId}"]`)!;
  const lanesOf = (el: HTMLElement): HTMLElement =>
    el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-lanes"]')!;
  const clipOf = (el: HTMLElement, beatId: string): HTMLElement =>
    el.querySelector<HTMLElement>(`[data-testid="sizzle-timeline-clip-${beatId}"]`)!;
  const pointer = async (target: Element, type: string, clientX: number, pointerId = 1): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId, clientX }));
    });
  };

  test("a boundary grip retimes the clip it leads into: live re-flow, the preview parks on the edge, ONE commit on release", async () => {
    const onScrub = vi.fn();
    const onDragCommit = vi.fn();
    const el = await render({ model: resolvedModel(), onScrub, onDragCommit });
    // 125 px/s. c starts at 6 s = 750 px; drag its boundary to 7 s.
    await pointer(grip(el, "c"), "pointerdown", 750);
    await pointer(lanesOf(el), "pointermove", 875);
    expect(parseFloat(clipOf(el, "c").style.left)).toBeCloseTo(875, 0);
    // b (anchored at 4 s) runs to the new boundary: 4–7 s = 375 px.
    expect(parseFloat(clipOf(el, "b").style.width)).toBeCloseTo(374, 0);
    expect(clipOf(el, "c").classList.contains("is-dragging")).toBe(true);
    expect(el.querySelector('[data-testid="sizzle-timeline-drag-tip"]')?.textContent).toBe("0:07.0");
    expect(onScrub).toHaveBeenLastCalledWith(7);
    expect(onDragCommit).not.toHaveBeenCalled(); // nothing written while dragging
    await pointer(lanesOf(el), "pointerup", 875);
    expect(onDragCommit).toHaveBeenCalledTimes(1);
    expect(onDragCommit).toHaveBeenCalledWith({
      sceneId: "s1",
      beatId: "c",
      index: 2,
      kind: "start",
      sec: 7,
      clipStartSec: 6,
      clipEndSec: 8
    });
    // The drag-local view is gone; the lane draws the model again (the
    // test never fed the commit back, so c is back where the model has it).
    expect(parseFloat(clipOf(el, "c").style.left)).toBeCloseTo(750, 0);
    expect(el.querySelector('[data-testid="sizzle-timeline-drag-tip"]')).toBeNull();
  });

  test("a drag is clamped so every clip keeps its minimum; the scrub that follows a drag's release is swallowed", async () => {
    const onDragCommit = vi.fn();
    const onSelectClip = vi.fn();
    const el = await render({ model: resolvedModel(), onDragCommit, onSelectClip });
    await pointer(grip(el, "c"), "pointerdown", 750);
    await pointer(lanesOf(el), "pointermove", 1000); // 8 s — past the scene end
    await pointer(lanesOf(el), "pointerup", 1000);
    expect(onDragCommit).toHaveBeenCalledWith(expect.objectContaining({ beatId: "c", sec: 7.9 }));
    // The click that the browser fires after that pointerup must not clear
    // the selection (it is the tail of the drag, not a press on bare track).
    await act(async () => {
      lanesOf(el).click();
    });
    expect(onSelectClip).not.toHaveBeenCalled();
    // …but the NEXT bare-track click does.
    await act(async () => {
      lanesOf(el).click();
    });
    expect(onSelectClip).toHaveBeenCalledWith(null);
  });

  test("a body press under the threshold is a click (selects, commits nothing); past it the clip follows the hand", async () => {
    const onDragCommit = vi.fn();
    const onSelectClip = vi.fn();
    const onScrub = vi.fn();
    const el = await render({ model: resolvedModel(), onDragCommit, onSelectClip, onScrub });
    const b = clipOf(el, "b"); // 4–6 s = 500–750 px
    expect(b.classList.contains("is-grab")).toBe(true);
    await pointer(b, "pointerdown", 510);
    await pointer(lanesOf(el), "pointermove", 512); // 2 px: not a drag yet
    expect(onScrub).not.toHaveBeenCalled();
    await pointer(lanesOf(el), "pointerup", 512);
    expect(onDragCommit).not.toHaveBeenCalled();
    await act(async () => {
      b.click();
    });
    expect(onSelectClip).toHaveBeenCalledWith(expect.objectContaining({ beatId: "b" }));
    // A real drag: +125 px = +1 s. The pointer's offset from the clip's
    // start (10 px = 0.08 s) is kept, so b lands at exactly 5 s.
    await pointer(b, "pointerdown", 510);
    await pointer(lanesOf(el), "pointermove", 635);
    expect(parseFloat(clipOf(el, "b").style.left)).toBeCloseTo(625, 0);
    // c (auto) re-flows to the middle of [5, 8] = 6.5 s.
    expect(parseFloat(clipOf(el, "c").style.left)).toBeCloseTo(812.5, 0);
    await pointer(lanesOf(el), "pointerup", 635);
    expect(onDragCommit).toHaveBeenCalledTimes(1);
    expect(onDragCommit).toHaveBeenCalledWith(expect.objectContaining({ beatId: "b", index: 1, kind: "start", sec: 5 }));
  });

  test("Escape abandons a drag: the preview is dropped and nothing is committed", async () => {
    const onDragCommit = vi.fn();
    const el = await render({ model: resolvedModel(), onDragCommit });
    await pointer(grip(el, "c"), "pointerdown", 750);
    await pointer(lanesOf(el), "pointermove", 875);
    expect(parseFloat(clipOf(el, "c").style.left)).toBeCloseTo(875, 0);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(parseFloat(clipOf(el, "c").style.left)).toBeCloseTo(750, 0);
    await pointer(lanesOf(el), "pointerup", 875);
    expect(onDragCommit).not.toHaveBeenCalled();
  });

  test("lost pointer capture commits at the last observed position", async () => {
    const onDragCommit = vi.fn();
    const el = await render({ model: resolvedModel(), onDragCommit });
    await pointer(grip(el, "c"), "pointerdown", 750);
    await pointer(lanesOf(el), "pointermove", 812.5);
    await act(async () => {
      lanesOf(el).dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 1 }));
    });
    expect(onDragCommit).toHaveBeenCalledWith(expect.objectContaining({ beatId: "c", sec: 6.5 }));
  });

  test("only the final clip's end has a grip, clip 0 has no start grip, and a read-only lane has none at all", async () => {
    const onDragCommit = vi.fn();
    const el = await render({ model: resolvedModel(), onDragCommit });
    expect(el.querySelector('[data-testid="sizzle-timeline-grip-a"]')).toBeNull();
    expect(el.querySelector('[data-testid="sizzle-timeline-grip-end-b"]')).toBeNull();
    const endGrip = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-grip-end-c"]')!;
    expect(endGrip).not.toBeNull();
    expect(clipOf(el, "a").classList.contains("is-grab")).toBe(false);
    // Drag the end from 8 s to 7.2 s.
    await pointer(endGrip, "pointerdown", 1000);
    await pointer(lanesOf(el), "pointermove", 900);
    expect(parseFloat(clipOf(el, "c").style.width)).toBeCloseTo(149, 0);
    await pointer(lanesOf(el), "pointerup", 900);
    expect(onDragCommit).toHaveBeenCalledWith(
      expect.objectContaining({ beatId: "c", index: 2, kind: "end", sec: 7.2, clipStartSec: 6, clipEndSec: 8 })
    );
    // Read-only (no onDragCommit): no grips, no grab cursor.
    const ro = await render({ model: resolvedModel() });
    expect(ro.querySelector('[data-testid^="sizzle-timeline-grip-"]')).toBeNull();
    expect(clipOf(ro, "b").classList.contains("is-grab")).toBe(false);
  });
});

describe("SizzleTimeline — a click is still a click under pointer capture", () => {
  // With capture on the lanes, Chromium targets the trailing `click` at the
  // LANES, not the clip: a press-release on a clip then reads as a bare-
  // track click and would CLEAR the selection. Found in the live app; jsdom's
  // `element.click()` cannot reproduce it, so this drives the real sequence.
  const pointer = async (target: Element, type: string, clientX: number): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX }));
    });
  };

  test("press + release on a clip body selects it; the browser's trailing click on the lanes is swallowed", async () => {
    const onSelectClip = vi.fn();
    const onDragCommit = vi.fn();
    const el = await render({ model: resolvedModel(), onSelectClip, onDragCommit });
    const lanes = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-lanes"]')!;
    const b = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-clip-b"]')!;
    await pointer(b, "pointerdown", 600);
    await pointer(lanes, "pointerup", 601); // delivered to the capturing lanes
    await act(async () => {
      lanes.click(); // what the browser fires next, targeted at the lanes
    });
    expect(onSelectClip).toHaveBeenCalledTimes(1);
    expect(onSelectClip).toHaveBeenCalledWith(expect.objectContaining({ beatId: "b" }));
    expect(onDragCommit).not.toHaveBeenCalled();
    // A zero-movement press on a grip selects too and pins NOTHING.
    const grip = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-grip-c"]')!;
    await pointer(grip, "pointerdown", 750);
    await pointer(lanes, "pointerup", 750);
    await act(async () => {
      lanes.click();
    });
    expect(onSelectClip).toHaveBeenLastCalledWith(expect.objectContaining({ beatId: "c" }));
    expect(onDragCommit).not.toHaveBeenCalled();
  });
});
