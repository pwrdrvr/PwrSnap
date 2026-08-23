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
