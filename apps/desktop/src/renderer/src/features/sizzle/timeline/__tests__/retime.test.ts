import { describe, expect, test } from "vitest";
import {
  resolvePhraseTiming,
  type SizzleScene,
  type SizzleSequenceBeat,
  type SizzleWordTiming
} from "@pwrsnap/shared";
import { buildTimelineModel, type TimelineSceneRegion } from "../timeline-model";
import {
  applyClipStartDrag,
  applyFinalEndDrag,
  clampToBounds,
  clipStartDragBounds,
  finalEndDragBounds,
  previewClipStarts
} from "../retime";

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
// 16 words, one every 0.5 s, over an 8 s narration.
const SCRIPT = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen";
const WORDS: SizzleWordTiming[] = SCRIPT.split(" ").map((word, index) => ({
  index,
  word,
  normalized: word,
  startSec: index * 0.5,
  endSec: index * 0.5 + 0.4
}));
const phrase = (p: string, offsetSec = 0, durationSec: number | null = null): SizzleSequenceBeat["timing"] => ({
  kind: "phrase",
  phrase: p,
  occurrence: 1,
  offsetSec,
  durationSec
});

/** A resolved scene region: a@0 (auto), b anchored at 4.0 ("nine"), c + d auto. */
function region(beats: SizzleSequenceBeat[], words: SizzleWordTiming[] | null = WORDS): TimelineSceneRegion {
  const model = buildTimelineModel({
    scenes: [sequence("s1", SCRIPT, beats)],
    sourceFor: () => ({ words, context: { capture: null, narrationDurationSec: 8 } })
  });
  return model.scenes[0]!;
}
const BEATS = [beat("a"), beat("b", { timing: phrase("nine") }), beat("c"), beat("d")];

describe("drag bounds", () => {
  test("a start is bounded by the neighbouring ANCHORS, less a minimum slice per clip in between", () => {
    const scene = region(BEATS);
    expect(scene.clips.map((c) => c.localStartSec)).toEqual([0, 4, 5.333, 6.667]);
    // c (auto): previous anchor is b at 4.0, no anchor after → the scene
    // end. One slice for c itself before, c + d after.
    expect(clipStartDragBounds(scene, 2)).toEqual({ minSec: 4.1, maxSec: 7.8 });
    // b (anchored): previous anchor is clip 0 at 0; b, c, d after it.
    expect(clipStartDragBounds(scene, 1)).toEqual({ minSec: 0.1, maxSec: 7.7 });
    // The final clip's end: from its start + minimum to the scene end.
    const endBounds = finalEndDragBounds(scene);
    expect(endBounds.minSec).toBeCloseTo(6.767, 3);
    expect(endBounds.maxSec).toBe(8);
    expect(clampToBounds(9, finalEndDragBounds(scene))).toBe(8);
    expect(clampToBounds(-1, clipStartDragBounds(scene, 1))).toBe(0.1);
  });
});

describe("previewClipStarts", () => {
  test("re-flows the auto neighbours around the dragged clip with the planner's own distributor", () => {
    const scene = region(BEATS);
    // c dragged to 5.0: b keeps 4.0 (anchored), d (auto) re-flows to the
    // middle of [5.0, 8].
    expect(previewClipStarts(scene, 2, 5)).toEqual([0, 4, 5, 6.5]);
    // b dragged to 2.0: c and d split [2, 8] three ways.
    expect(previewClipStarts(scene, 1, 2)).toEqual([0, 2, 4, 6]);
  });
});

describe("applyClipStartDrag", () => {
  test("with a transcript: the nearest word + the residual — never quantized to the word", () => {
    const next = applyClipStartDrag(BEATS, 2, 5.3, { words: WORDS, clipEndSec: 6.667 });
    // 5.3 s is nearer word 11 "twelve" (5.5) than word 10 (5.0): −0.2 residual.
    expect(next[2]!.timing).toEqual(phrase("twelve", -0.2));
    // Only the touched clip changed.
    expect(next[0]).toBe(BEATS[0]);
    expect(next[1]).toBe(BEATS[1]);
    expect(next[3]).toBe(BEATS[3]);
    // …and it resolves to the dropped time through the planner's matcher.
    const resolved = resolvePhraseTiming(
      { words: WORDS, quality: "precise", warnings: [] },
      { phrase: "twelve", occurrence: 1, offsetSec: -0.2, durationSec: null }
    );
    expect(resolved!.startSec).toBeCloseTo(5.3, 3);
  });

  test("without a transcript: an offset, the fallback", () => {
    const next = applyClipStartDrag(BEATS, 2, 5.3, { words: [], clipEndSec: 6.667 });
    expect(next[2]!.timing).toEqual({ kind: "offset", startSec: 5.3, endSec: null });
  });

  test("clip 0 cannot be dragged off 0 (the same array comes back)", () => {
    expect(applyClipStartDrag(BEATS, 0, 1, { words: WORDS, clipEndSec: 4 })).toBe(BEATS);
    expect(applyClipStartDrag(BEATS, 9, 1, { words: WORDS, clipEndSec: 4 })).toBe(BEATS);
  });

  test("a final clip's explicit end stays put when only its start moves", () => {
    const beats = [beat("a"), beat("b", { timing: phrase("nine") }), beat("c"), beat("d", { timing: { kind: "offset", startSec: 6, endSec: 7.5 } })];
    const scene = region(beats);
    expect(scene.clips[3]!.localEndSec).toBe(7.5);
    const next = applyClipStartDrag(beats, 3, 6.5, { words: WORDS, clipEndSec: 7.5 });
    // Word 13 "fourteen" starts at exactly 6.5 → no residual; the end is
    // carried as a duration from the new start.
    expect(next[3]!.timing).toEqual(phrase("fourteen", 0, 1));
  });

  test("a non-final clip never keeps an end (continuity)", () => {
    const beats = [beat("a"), beat("b", { timing: { kind: "offset", startSec: 2, endSec: 3 } }), beat("c")];
    const next = applyClipStartDrag(beats, 1, 2.5, { words: [], clipEndSec: 3 });
    expect(next[1]!.timing).toEqual({ kind: "offset", startSec: 2.5, endSec: null });
  });
});

describe("applyFinalEndDrag", () => {
  test("an auto final clip is pinned at its current start and carries the end as a duration", () => {
    const scene = region(BEATS);
    const d = scene.clips[3]!;
    const next = applyFinalEndDrag(BEATS, 7.2, { words: WORDS, clipStartSec: d.localStartSec, durationSec: 8 });
    // 6.667 s is nearest word 13 "fourteen" (6.5): +0.167 residual; 7.2 − 6.667 = 0.533.
    expect(next[3]!.timing).toEqual(phrase("fourteen", 0.167, 0.533));
    expect(next[0]).toBe(BEATS[0]);
  });

  test("without a transcript the end rides on an offset", () => {
    const next = applyFinalEndDrag(BEATS, 7.2, { words: [], clipStartSec: 6.667, durationSec: 8 });
    expect(next[3]!.timing).toEqual({ kind: "offset", startSec: 6.667, endSec: 7.2 });
  });

  test("dragging the end back to the scene end clears it; an auto clip is left untouched", () => {
    expect(applyFinalEndDrag(BEATS, 7.98, { words: WORDS, clipStartSec: 6.667, durationSec: 8 })).toBe(BEATS);
    const pinned = [beat("a"), beat("b", { timing: phrase("nine", 0, 2) })];
    const next = applyFinalEndDrag(pinned, 8, { words: WORDS, clipStartSec: 4, durationSec: 8 });
    expect(next[1]!.timing).toEqual(phrase("nine", 0, null));
  });

  test("a lone clip carries its end on an offset at 0 — no phrase is invented", () => {
    const lone = [beat("a")];
    const next = applyFinalEndDrag(lone, 3, { words: WORDS, clipStartSec: 0, durationSec: 8 });
    expect(next[0]!.timing).toEqual({ kind: "offset", startSec: 0, endSec: 3 });
  });

  test("the end never comes before start + minimum", () => {
    const next = applyFinalEndDrag(BEATS, 6.7, { words: [], clipStartSec: 6.667, durationSec: 8 });
    expect(next[3]!.timing).toEqual({ kind: "offset", startSec: 6.667, endSec: 6.767 });
  });
});
