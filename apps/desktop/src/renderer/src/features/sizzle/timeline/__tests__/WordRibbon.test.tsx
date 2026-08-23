// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { SizzleScene, SizzleSequenceBeat, SizzleWordTiming } from "@pwrsnap/shared";
import {
  layoutRibbonWords,
  legibleZoomForWords,
  ribbonLaneHeightPx,
  RIBBON_ROWS,
  WordRibbon
} from "../WordRibbon";
import {
  buildTimelineModel,
  type TimelineModel,
  type TimelineSceneRegion,
  type TimelineWord
} from "../timeline-model";

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

const beat = (id: string, patch: Partial<SizzleSequenceBeat> = {}): SizzleSequenceBeat => ({
  id,
  captureId: `cap_${id}`,
  timing: { kind: "auto" },
  mediaTrim: null,
  transition: "cut",
  videoFit: "smart-fit",
  ...patch
});
const sequence = (id: string, narration: string, beats: SizzleSequenceBeat[]): SizzleScene => ({
  id,
  kind: "sequence",
  captureId: beats[0]?.captureId ?? "",
  scriptLine: narration,
  narration,
  beats,
  durationOverrideSec: null,
  mediaTrim: null,
  audioSource: "voiceover",
  transition: "crossfade"
});
const SCRIPT = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen";
const WORDS: SizzleWordTiming[] = SCRIPT.split(" ").map((word, index) => ({
  index, word, normalized: word, startSec: index * 0.5, endSec: index * 0.5 + 0.4
}));

type ClickWord = (scene: TimelineSceneRegion, word: TimelineWord) => void;
type Synthesize = (sceneId: string) => void;

async function render(
  model: TimelineModel,
  pxPerSec: number,
  handlers: { onClickWord?: ClickWord; onSynthesize?: Synthesize } = {}
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(WordRibbon, {
        model,
        x: (sec: number) => sec * pxPerSec,
        pxPerSec,
        widthPx: 1000,
        visible: { startSec: 0, endSec: Number.POSITIVE_INFINITY },
        onClickWord: handlers.onClickWord ?? (() => undefined),
        onSynthesize: handlers.onSynthesize ?? (() => undefined)
      })
    );
  });
  return container;
}

describe("WordRibbon", () => {
  test("a resolved scene draws every word at its spoken time; the anchored word carries the clip badge", async () => {
    const model = buildTimelineModel({
      scenes: [
        sequence("s1", SCRIPT, [
          beat("a"),
          beat("b", { timing: { kind: "phrase", phrase: "nine", occurrence: 1, offsetSec: 0, durationSec: null } })
        ])
      ],
      sourceFor: () => ({ words: WORDS, context: { capture: null, narrationDurationSec: 8 } })
    });
    const onClickWord = vi.fn<ClickWord>();
    const el = await render(model, 125, { onClickWord }); // 8 s over 1000 px: 62.5 px per word, all labels fit
    const words = el.querySelectorAll('[data-testid^="sizzle-timeline-word-0-"]');
    expect(words.length).toBe(16);
    const nine = el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-word-0-8"]')!;
    expect(nine.style.left).toBe("500px"); // 4.0 s × 125
    expect(nine.classList.contains("is-anch")).toBe(true);
    expect(nine.querySelector(".szt__badge")?.textContent).toBe("2");
    expect(el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-word-0-3"]')!.classList.contains("is-anch")).toBe(false);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-timeline-word-0-3"]')!.click();
    });
    expect(onClickWord).toHaveBeenCalledTimes(1);
    const [scene, word] = onClickWord.mock.calls[0]!;
    expect(scene.sceneId).toBe("s1");
    expect(word.index).toBe(3);
    expect(word.absStartSec).toBe(1.5);
    expect(el.querySelector('[data-testid^="sizzle-timeline-ribbon-empty-"]')).toBeNull();
  });

  test("an estimated scene fabricates nothing: no words, just the Synthesize affordance", async () => {
    const model = buildTimelineModel({
      scenes: [sequence("s1", SCRIPT, [beat("a"), beat("b")])],
      sourceFor: () => ({ words: null, context: { capture: null } })
    });
    const onSynthesize = vi.fn<Synthesize>();
    const el = await render(model, 100, { onSynthesize });
    expect(el.querySelectorAll('[data-testid^="sizzle-timeline-word-"]').length).toBe(0);
    expect(el.querySelector('[data-testid="sizzle-timeline-ribbon-empty-0"]')).not.toBeNull();
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="sizzle-timeline-synthesize-0"]')!.click();
    });
    expect(onSynthesize).toHaveBeenCalledWith("s1");
  });

  test("dense words become ticks rather than overlapping labels; anchored words are placed first", () => {
    const words = WORDS.map((w, pos) => ({ ...w, pos, absStartSec: w.startSec, absEndSec: w.endSec }));
    // 10 px/s: words 5 px apart — only a few labels fit, the rest tick.
    const placed = layoutRibbonWords(words, 6, new Set([8]));
    const ticks = placed.filter((p) => p.tick).length;
    expect(ticks).toBeGreaterThan(4);
    // Word 8 is anchored and was placed first, so it keeps its label.
    const eight = placed.find((p) => p.word.index === 8)!;
    expect(eight.tick).toBe(false);
    // At 125 px/s everything fits on the first row.
    const roomy = layoutRibbonWords(words, 125, new Set());
    expect(roomy.every((p) => !p.tick)).toBe(true);
  });

  test("the lane is sized to the rows the narration uses, not to the six it may use", async () => {
    const model = buildTimelineModel({
      scenes: [sequence("s1", SCRIPT, [beat("a")])],
      sourceFor: () => ({ words: WORDS, context: { capture: null, narrationDurationSec: 8 } })
    });
    // Roomy: every word clears on row 0, so the lane is one row tall — but
    // never below the floor the "Synthesize" button needs.
    const laneHeight = (el: HTMLDivElement): number =>
      Number.parseInt(el.querySelector<HTMLElement>('[data-testid="sizzle-timeline-ribbon"]')!.style.height, 10);
    const roomyPx = laneHeight(await render(model, 125));
    expect(roomyPx).toBe(ribbonLaneHeightPx(1));
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    // Cramped: the same words at 30 px/s stagger down several rows, and the
    // lane grows to hold them.
    const densePx = laneHeight(await render(model, 30));
    expect(densePx).toBeGreaterThan(roomyPx);
    expect(densePx).toBeLessThanOrEqual(ribbonLaneHeightPx(RIBBON_ROWS));
  });

  describe("legibleZoomForWords", () => {
    const words = WORDS.map((w, pos) => ({ ...w, pos, absStartSec: w.startSec, absEndSec: w.endSec }));

    test("a narration crammed into fit picks the coarsest density that still reads", () => {
      // 8 s of words in a ~152 px column is 19 px/s — the density the
      // operator was shown, where words 9.5 px apart cannot carry a label
      // and the ribbon stacks to its ceiling.
      expect(legibleZoomForWords(words, 19)).toBe(2);
      // Denser fits are honoured too: the answer is a density, not a rung.
      expect(legibleZoomForWords(words, 45)).toBe(2);
    });

    test("a reel that already reads at fit stays at fit — a rung would show empty track", () => {
      // A short reel in a wide column: fit is 200 px/s, denser than 2x and
      // 4x, so no rung is an improvement.
      expect(legibleZoomForWords(words, 200)).toBe("fit");
    });

    test("nothing to lay out means no opinion", () => {
      expect(legibleZoomForWords([], 19)).toBe("fit");
      expect(legibleZoomForWords(words, 0)).toBe("fit"); // column not measured yet
    });

    test("the chosen density actually clears the ribbon in two rows", () => {
      const zoom = legibleZoomForWords(words, 19);
      const pxPerSec = zoom === "fit" ? 19 : 40 * zoom;
      const placed = layoutRibbonWords(words, pxPerSec, new Set(), Number.POSITIVE_INFINITY, 2);
      expect(placed.filter((p) => p.tick).length).toBe(0);
      // And the density the operator was shown does not.
      const atFit = layoutRibbonWords(words, 19, new Set(), Number.POSITIVE_INFINITY, 2);
      expect(atFit.filter((p) => p.tick).length).toBeGreaterThan(0);
    });
  });

  test("a label that would run past the lanes' right edge is a tick, so the ribbon never widens the scroll area", () => {
    const words = WORDS.map((w, pos) => ({ ...w, pos, absStartSec: w.startSec, absEndSec: w.endSec }));
    // Word 15 ("sixteen") starts at 7.5 s = 937.5 px; its label needs ~58 px
    // (7 chars × 7.1 + the 8 px gap) → ends past a 990 px edge.
    const bounded = layoutRibbonWords(words, 125, new Set(), 990);
    expect(bounded.find((p) => p.word.index === 15)!.tick).toBe(true);
    expect(bounded.find((p) => p.word.index === 14)!.tick).toBe(false); // "fifteen" at 875 px ends at ~933
    // Unbounded (the default), the same word keeps its label.
    expect(layoutRibbonWords(words, 125, new Set()).find((p) => p.word.index === 15)!.tick).toBe(false);
  });
});
