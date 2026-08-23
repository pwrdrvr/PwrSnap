import { describe, expect, test } from "vitest";
import type {
  SizzleScene,
  SizzleSequenceBeat,
  SizzleSequencePreviewPlan,
  SizzleWordTiming
} from "@pwrsnap/shared";
import { buildTimelineModel, clipAt, sceneAt, type TimelineSceneSource } from "../timeline-model";

const beat = (id: string, patch: Partial<SizzleSequenceBeat> = {}): SizzleSequenceBeat => ({
  id,
  captureId: `cap_${id}`,
  timing: { kind: "auto" },
  mediaTrim: null,
  transition: "cut",
  videoFit: "smart-fit",
  ...patch
});

const sequence = (
  id: string,
  narration: string,
  beats: SizzleSequenceBeat[],
  patch: Partial<SizzleScene> = {}
): SizzleScene => ({
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

// 16 words spoken evenly over 8 s.
const SCRIPT = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen";
const WORDS: SizzleWordTiming[] = SCRIPT.split(" ").map((word, index) => ({
  index,
  word,
  normalized: word,
  startSec: index * 0.5,
  endSec: index * 0.5 + 0.4
}));

const estimatedSource: TimelineSceneSource = {
  words: null,
  context: { capture: null }
};

const cachedSource: TimelineSceneSource = {
  words: WORDS,
  context: { capture: null, narrationDurationSec: 8 }
};

describe("buildTimelineModel", () => {
  test("a scene with no timing is ESTIMATED: word-count length, ~ everywhere, no words", () => {
    // 16 words at 160 wpm = 6 s.
    const scenes = [sequence("s1", SCRIPT, [beat("a"), beat("b"), beat("c")])];
    const model = buildTimelineModel({ scenes, sourceFor: () => estimatedSource });
    expect(model.exact).toBe(false);
    expect(model.totalSec).toBeCloseTo(6, 5);
    const region = model.scenes[0]!;
    expect(region.exactness).toBe("estimated");
    expect(region.words).toEqual([]);
    expect(region.clips.map((c) => [c.startSec, c.endSec])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6]
    ]);
    expect(region.clips.every((c) => !c.exact && !c.anchored)).toBe(true);
  });

  test("cached words + measured duration are RESOLVED through the shared planner", () => {
    const scenes = [
      sequence("s1", SCRIPT, [
        beat("a"),
        // Anchors to word 8 ("nine") at 4.0 s, +0.1 s residual.
        beat("b", { timing: { kind: "phrase", phrase: "nine", occurrence: 1, offsetSec: 0.1, durationSec: null } }),
        beat("c")
      ])
    ];
    const model = buildTimelineModel({ scenes, sourceFor: () => cachedSource });
    expect(model.exact).toBe(true);
    expect(model.totalSec).toBe(8);
    const region = model.scenes[0]!;
    expect(region.exactness).toBe("resolved");
    expect(region.words).toHaveLength(16);
    expect(region.words[8]!.absStartSec).toBe(4);
    const [a, b, c] = region.clips;
    expect(a!.startSec).toBe(0);
    expect(b!.startSec).toBeCloseTo(4.1, 3); // word start + offsetSec, not quantized
    expect(b!.anchored).toBe(true);
    expect(c!.startSec).toBeCloseTo(6.05, 3); // auto: halfway between the anchor and the end
    expect(c!.endSec).toBe(8);
    expect(c!.anchored).toBe(false);
  });

  test("a phrase that is not in the transcript degrades to auto with the planner's warning", () => {
    const scenes = [
      sequence("s1", SCRIPT, [
        beat("a"),
        beat("b", { timing: { kind: "phrase", phrase: "Settings", occurrence: 1, offsetSec: 0, durationSec: null } })
      ])
    ];
    const model = buildTimelineModel({ scenes, sourceFor: () => cachedSource });
    const [, b] = model.scenes[0]!.clips;
    expect(b!.unresolved).toBe(true);
    expect(b!.anchored).toBe(false);
    expect(b!.pendingAnchor).toBe(true);
    expect(b!.startSec).toBe(4); // auto: halfway
    expect(model.scenes[0]!.diagnostics.some((d) => d.code === "phrase_unresolved")).toBe(true);
  });

  test("a plan from this session wins over cached words and carries its own windows", () => {
    const plan: SizzleSequencePreviewPlan = {
      audioBase64: "",
      mimeType: "audio/mpeg",
      durationSec: 10,
      timingQuality: "precise",
      warnings: [{ beatId: "b", code: "beat_too_short", message: "short" }],
      transcriptPhrases: [],
      words: WORDS,
      beats: [
        { beatId: "a", captureId: "cap_a", startSec: 0, endSec: 7, timing: { kind: "auto" }, transition: "crossfade", videoFit: "smart-fit" },
        { beatId: "b", captureId: "cap_b", startSec: 7, endSec: 10, timing: { kind: "auto" }, transition: "cut", videoFit: "smart-fit" }
      ]
    };
    const scenes = [sequence("s1", SCRIPT, [beat("a"), beat("b")])];
    const model = buildTimelineModel({
      scenes,
      sourceFor: () => ({ plan, words: WORDS, context: { capture: null, sequencePlanDurationSec: 10 } })
    });
    expect(model.totalSec).toBe(10);
    expect(model.scenes[0]!.clips.map((c) => [c.startSec, c.endSec])).toEqual([
      [0, 7],
      [7, 10]
    ]);
    expect(model.scenes[0]!.clips[1]!.tooShort).toBe(true);
  });

  test("two scenes sit on ONE axis; a fade-like transition overlaps, a cut does not; exactness is per scene", () => {
    const s1 = sequence("s1", SCRIPT, [beat("a")]); // resolved: 8 s
    const s2 = sequence("s2", SCRIPT, [beat("b")], { transition: "crossfade" }); // estimated: 6 s, 0.4 s overlap
    const s3 = sequence("s3", SCRIPT, [beat("c")], { transition: "cut" }); // estimated: 6 s, no overlap
    const model = buildTimelineModel({
      scenes: [s1, s2, s3],
      sourceFor: (scene) => (scene.id === "s1" ? cachedSource : estimatedSource)
    });
    expect(model.exact).toBe(false);
    const [r1, r2, r3] = model.scenes;
    expect(r1!.exact).toBe(true);
    expect([r1!.startSec, r1!.endSec]).toEqual([0, 8]);
    expect(r2!.exact).toBe(false);
    expect(r2!.startSec).toBeCloseTo(7.6, 5);
    expect(r2!.endSec).toBeCloseTo(13.6, 5);
    expect(r3!.startSec).toBeCloseTo(13.6, 5);
    expect(model.totalSec).toBeCloseTo(19.6, 5);
    // Clips are placed on the project axis, not the scene axis.
    expect(r2!.clips[0]!.startSec).toBeCloseTo(7.6, 5);
    expect(r2!.clips[0]!.localStartSec).toBe(0);
  });

  test("a legacy simple scene is one clip spanning its region", () => {
    const simple: SizzleScene = {
      id: "legacy",
      captureId: "cap_x",
      scriptLine: "",
      durationOverrideSec: 4,
      mediaTrim: null,
      audioSource: "muted",
      transition: "crossfade"
    };
    const model = buildTimelineModel({
      scenes: [simple],
      sourceFor: () => ({ words: null, context: { capture: { kind: "image" } } })
    });
    expect(model.exact).toBe(true);
    expect(model.scenes[0]!.kind).toBe("simple");
    expect(model.scenes[0]!.clips).toHaveLength(1);
    expect(model.scenes[0]!.clips[0]!.endSec).toBe(4);
  });

  test("80 clips (the cap) at Fit: every clip still gets a window and they tile the scene", () => {
    const beats = Array.from({ length: 80 }, (_, i) => beat(`b${i}`));
    const scenes = [sequence("s1", SCRIPT, beats)];
    const model = buildTimelineModel({ scenes, sourceFor: () => cachedSource });
    const clips = model.scenes[0]!.clips;
    expect(clips).toHaveLength(80);
    expect(clips[0]!.startSec).toBe(0);
    expect(clips[79]!.endSec).toBe(8);
    for (let i = 1; i < clips.length; i += 1) {
      expect(clips[i]!.startSec).toBeCloseTo(clips[i - 1]!.endSec, 6);
    }
  });

  test("sceneAt / clipAt find the region and clip under a project time", () => {
    const s1 = sequence("s1", SCRIPT, [beat("a"), beat("b")]);
    const s2 = sequence("s2", SCRIPT, [beat("c")], { transition: "cut" });
    const model = buildTimelineModel({ scenes: [s1, s2], sourceFor: () => cachedSource });
    expect(sceneAt(model, 3)!.sceneId).toBe("s1");
    expect(clipAt(sceneAt(model, 3)!, 3)!.beatId).toBe("a");
    expect(clipAt(sceneAt(model, 5)!, 5)!.beatId).toBe("b");
    expect(sceneAt(model, 9)!.sceneId).toBe("s2");
    expect(sceneAt(model, 99)!.sceneId).toBe("s2"); // past the end clamps to the last scene
  });
});
