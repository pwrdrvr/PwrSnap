import { describe, expect, test } from "vitest";
import type { SizzleScene, SizzleSequenceBeat, SizzleWordTiming } from "@pwrsnap/shared";
import { buildTimelineModel } from "../timeline/timeline-model";
import { flattenReelClips, reelClipProgress, reelFrameAt } from "../reel-frame";

const beat = (id: string, patch: Partial<SizzleSequenceBeat> = {}): SizzleSequenceBeat => ({
  id,
  captureId: `cap_${id}`,
  timing: { kind: "auto" },
  mediaTrim: null,
  transition: "cut",
  videoFit: "smart-fit",
  ...patch
});
const SCRIPT = "one two three four five six seven eight nine ten eleven twelve";
const WORDS: SizzleWordTiming[] = SCRIPT.split(" ").map((word, index) => ({
  index,
  word,
  normalized: word,
  startSec: index * 0.5,
  endSec: index * 0.5 + 0.4
}));
const sequence = (id: string, beats: SizzleSequenceBeat[], patch: Partial<SizzleScene> = {}): SizzleScene => ({
  id,
  kind: "sequence",
  captureId: beats[0]?.captureId ?? "",
  scriptLine: SCRIPT,
  narration: SCRIPT,
  beats,
  durationOverrideSec: null,
  mediaTrim: null,
  audioSource: "voiceover",
  transition: "crossfade",
  ...patch
});
/** A legacy one-capture scene — the shape a pre-sequence reel is made of. */
const simple = (id: string, patch: Partial<SizzleScene> = {}): SizzleScene => ({
  id,
  captureId: `cap_${id}`,
  scriptLine: SCRIPT,
  durationOverrideSec: null,
  mediaTrim: null,
  audioSource: "voiceover",
  transition: "crossfade",
  ...patch
});
const resolved = (scenes: SizzleScene[]) =>
  buildTimelineModel({
    scenes,
    sourceFor: () => ({ words: WORDS, context: { capture: null, narrationDurationSec: 8 } })
  });

describe("reel-frame — one axis across scenes", () => {
  test("WITHIN a scene the dissolve runs BEFORE the incoming clip's own slot", () => {
    // Clip 1 carries a 0.4 s crossfade and starts at 4 s, so the export
    // makes its picture arrive at 3.6 s.
    const model = resolved([
      sequence("s1", [beat("a"), beat("b", { transition: "crossfade" })])
    ]);
    const clips = flattenReelClips(model);
    expect(clips.map((c) => c.startSec)).toEqual([0, 4]);
    expect(clips[1]!.sceneBoundary).toBe(false);
    expect(clips[1]!.blendStartSec).toBeCloseTo(3.6, 6);

    expect(reelFrameAt(clips, 3.5).blend).toBeNull();
    const mid = reelFrameAt(clips, 3.8);
    expect(mid.activeIndex).toBe(0); // the OUTGOING clip still owns the stage
    expect(mid.blend?.incomingIndex).toBe(1);
    expect(mid.blend?.progress).toBeCloseTo(0.5, 6);
    expect(reelFrameAt(clips, 4.2)).toEqual({ activeIndex: 1, blend: null });
  });

  test("ACROSS scenes the overlap is already on the axis, so the dissolve runs AFTER the incoming scene's start", () => {
    // `layoutSizzleScenes` pulls scene 2 back by the 0.4 s transition, so it
    // starts at 7.6. Subtracting 0.4 AGAIN here would open the dissolve at
    // 7.2 — a full transition early. This is the regression this test exists
    // for; it is also the ONLY transition kind a legacy simple-scene reel has.
    const model = resolved([
      sequence("s1", [beat("a")]),
      sequence("s2", [beat("b")], { transition: "crossfade" })
    ]);
    const clips = flattenReelClips(model);
    expect(clips[1]!.sceneBoundary).toBe(true);
    expect(clips[1]!.startSec).toBeCloseTo(7.6, 6);
    expect(clips[1]!.blendStartSec).toBeCloseTo(7.6, 6); // NOT 7.2

    expect(reelFrameAt(clips, 7.5).blend).toBeNull();
    const mid = reelFrameAt(clips, 7.8);
    expect(mid.activeIndex).toBe(0);
    expect(mid.blend?.incomingIndex).toBe(1);
    expect(mid.blend?.progress).toBeCloseTo(0.5, 6);
    // Past the window the incoming scene owns the stage alone.
    expect(reelFrameAt(clips, 8.2)).toEqual({ activeIndex: 1, blend: null });
  });

  test("a reel of legacy one-capture scenes is one clip per scene, and its scene transitions still blend", () => {
    const model = resolved([simple("s1"), simple("s2", { transition: { type: "push-left", durationSec: 0.5 } })]);
    const clips = flattenReelClips(model);
    expect(clips).toHaveLength(2);
    expect(clips.every((c) => c.sceneBoundary)).toBe(true);
    expect(clips[1]!.type).toBe("push-left");
    const mid = reelFrameAt(clips, clips[1]!.startSec + 0.25);
    expect(mid.activeIndex).toBe(0);
    expect(mid.blend?.type).toBe("push-left");
    expect(mid.blend?.progress).toBeCloseTo(0.5, 6);
  });

  test("a cut has no dissolve, and the first clip of the reel never blends in", () => {
    const model = resolved([
      sequence("s1", [beat("a")]),
      sequence("s2", [beat("b")], { transition: "cut" })
    ]);
    const clips = flattenReelClips(model);
    expect(clips[0]!.transitionSec).toBe(0); // nothing precedes the reel
    expect(clips[1]!.transitionSec).toBe(0); // a cut
    expect(reelFrameAt(clips, 7.9).blend).toBeNull();
    expect(reelFrameAt(clips, 8.1).blend).toBeNull();
  });

  test("edges: before the reel, past its end, and with no clips at all", () => {
    const clips = flattenReelClips(resolved([sequence("s1", [beat("a")])]));
    expect(reelFrameAt(clips, -5).activeIndex).toBe(0);
    expect(reelFrameAt(clips, 999)).toEqual({ activeIndex: 0, blend: null });
    expect(reelFrameAt([], 1)).toEqual({ activeIndex: -1, blend: null });
  });

  test("reelClipProgress is 0..1 across a clip's own slot", () => {
    const clips = flattenReelClips(resolved([sequence("s1", [beat("a"), beat("b")])]));
    const first = clips[0]!;
    expect(reelClipProgress(first, first.startSec)).toBe(0);
    expect(reelClipProgress(first, (first.startSec + first.endSec) / 2)).toBeCloseTo(0.5, 6);
    expect(reelClipProgress(first, first.endSec + 10)).toBe(1);
  });
});
