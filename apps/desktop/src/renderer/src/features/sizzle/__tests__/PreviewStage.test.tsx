// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, SizzleScene, SizzleSequencePreviewPlan } from "@pwrsnap/shared";
import { SequenceTimelinePreview } from "../PreviewStage";

vi.mock("wavesurfer.js", () => ({
  default: { create: () => ({ loadBlob: () => Promise.resolve(), destroy: () => undefined }) }
}));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

const imageCapture = (id: string): CaptureRecord =>
  ({
    id,
    kind: "image",
    source_app_name: `App ${id}`,
    edits_version: 0
  }) as unknown as CaptureRecord;
const videoCapture = (id: string): CaptureRecord =>
  ({
    id,
    kind: "video",
    source_app_name: `Video ${id}`,
    edits_version: 0,
    legacy_src_path: `/tmp/${id}.mp4`,
    video: { defaultRange: { start: 0, end: 6 }, durationSec: 6 }
  }) as unknown as CaptureRecord;

const SCENE: SizzleScene = {
  id: "sc_1",
  kind: "sequence",
  captureId: "cap_a",
  scriptLine: "one two three",
  narration: "one two three",
  beats: [
    { id: "a", captureId: "cap_a", timing: { kind: "auto" }, mediaTrim: null, transition: "cut", videoFit: "smart-fit" },
    { id: "b", captureId: "cap_b", timing: { kind: "auto" }, mediaTrim: null, transition: "crossfade", videoFit: "smart-fit" },
    { id: "c", captureId: "cap_c", timing: { kind: "auto" }, mediaTrim: null, transition: { type: "slide-left", durationSec: 0.5 }, videoFit: "smart-fit" }
  ],
  durationOverrideSec: null,
  mediaTrim: null,
  audioSource: "voiceover",
  transition: "crossfade"
};
// a 0–4 (image), b 4–6 (image, crossfade 0.4 in), c 6–8 (video, slide-left 0.5 in)
const PLAN: SizzleSequencePreviewPlan = {
  audioBase64: "AA==",
  mimeType: "audio/mpeg",
  durationSec: 8,
  timingQuality: "precise",
  warnings: [],
  transcriptPhrases: [],
  words: [],
  beats: [
    { beatId: "a", captureId: "cap_a", startSec: 0, endSec: 4, timing: { kind: "auto" }, transition: "crossfade", videoFit: "smart-fit" },
    { beatId: "b", captureId: "cap_b", startSec: 4, endSec: 6, timing: { kind: "auto" }, transition: "crossfade", videoFit: "smart-fit" },
    { beatId: "c", captureId: "cap_c", startSec: 6, endSec: 8, timing: { kind: "auto" }, transition: { type: "slide-left", durationSec: 0.5 }, videoFit: "smart-fit" }
  ]
} as unknown as SizzleSequencePreviewPlan;
const CAPTURES = new Map<string, CaptureRecord>([
  ["cap_a", imageCapture("cap_a")],
  ["cap_b", imageCapture("cap_b")],
  ["cap_c", videoCapture("cap_c")]
]);

async function render(currentTimeSec: number, playing = false): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(SequenceTimelinePreview, {
        scene: SCENE,
        captureMap: CAPTURES,
        plan: PLAN,
        audioBlob: undefined,
        currentTimeSec,
        playing,
        loading: false,
        onPlay: () => undefined,
        onSeek: () => undefined
      })
    );
  });
  return container;
}
const layer = (el: HTMLElement, role: "outgoing" | "incoming"): HTMLElement | null =>
  el.querySelector<HTMLElement>(`[data-testid="sizzle-preview-${role}"]`);

describe("SequenceTimelinePreview — transitions + Ken Burns (plan §4.7)", () => {
  test("outside a transition window: one layer, the active beat, with the export's Ken Burns on an image", async () => {
    const el = await render(1);
    const out = layer(el, "outgoing")!;
    expect(out.dataset.beat).toBe("a");
    expect(layer(el, "incoming")).toBeNull();
    const img = out.querySelector<HTMLImageElement>("img")!;
    // Beat 0 zooms IN over its 4 s visual span; parked at 1 s (paused).
    expect(img.dataset.kb).toBe("in");
    expect(img.style.animationName).toBe("szl-kb-in");
    expect(parseFloat(img.style.animationDuration)).toBeCloseTo(4, 3);
    expect(parseFloat(img.style.animationDelay)).toBeCloseTo(-1, 3);
    expect(img.style.animationPlayState).toBe("paused");
    expect(el.querySelectorAll("video").length).toBe(0);
  });

  test("in the last 0.4 s before b: b blends in over a with the crossfade animation seeked to the elapsed time", async () => {
    const el = await render(3.8, true);
    const out = layer(el, "outgoing")!;
    const inc = layer(el, "incoming")!;
    expect(out.dataset.beat).toBe("a");
    expect(inc.dataset.beat).toBe("b");
    expect(inc.classList.contains("is-crossfade")).toBe(true);
    expect(inc.dataset.progress).toBe("0.500");
    expect(inc.style.animationName).toBe("szl-xf-incoming-crossfade");
    expect(parseFloat(inc.style.animationDuration)).toBeCloseTo(0.4, 3);
    expect(parseFloat(inc.style.animationDelay)).toBeCloseTo(-0.2, 3);
    expect(inc.style.animationPlayState).toBe("running"); // playing → the blend runs between audio ticks
    // b (odd index) zooms OUT, over a visual span that starts 0.4 s early (3.6 → 6 = 2.4 s).
    const img = inc.querySelector<HTMLImageElement>("img")!;
    expect(img.dataset.kb).toBe("out");
    expect(parseFloat(img.style.animationDuration)).toBeCloseTo(2.4, 3);
    expect(parseFloat(img.style.animationDelay)).toBeCloseTo(-0.2, 3);
  });

  test("a slide-left moves BOTH layers; the incoming video is a first-frame stand-in, never the live player", async () => {
    const el = await render(5.75);
    const out = layer(el, "outgoing")!;
    const inc = layer(el, "incoming")!;
    expect(out.dataset.beat).toBe("b");
    expect(inc.dataset.beat).toBe("c");
    expect(out.style.animationName).toBe("szl-xf-outgoing-slide-left");
    expect(inc.style.animationName).toBe("szl-xf-incoming-slide-left");
    expect(inc.dataset.progress).toBe("0.500");
    const videos = el.querySelectorAll<HTMLVideoElement>("video");
    expect(videos.length).toBe(1); // only the incoming stand-in; b is an image
    expect(videos[0]!.getAttribute("src")).toContain("#t=0.000");
    expect(videos[0]!.getAttribute("preload")).toBe("metadata");
  });

  test("once c owns the stage it is the live video player, no Ken Burns, no incoming layer", async () => {
    const el = await render(7);
    const out = layer(el, "outgoing")!;
    expect(out.dataset.beat).toBe("c");
    expect(layer(el, "incoming")).toBeNull();
    const video = out.querySelector("video")!;
    expect(video.getAttribute("src")).not.toContain("#t=");
    expect(out.querySelector("img")).toBeNull();
  });
});
