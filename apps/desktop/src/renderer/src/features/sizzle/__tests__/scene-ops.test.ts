import { describe, expect, test } from "vitest";
import type { SizzleScene, SizzleSequenceBeat } from "@pwrsnap/shared";
import {
  convertSceneToSequence,
  moveSceneBy,
  patchSequenceBeat,
  removeSequenceBeatFrom,
  reorderSequenceBeatIn,
  splitSceneIntoScenes
} from "../scene-ops";

const beat = (id: string, patch: Partial<SizzleSequenceBeat> = {}): SizzleSequenceBeat => ({
  id,
  captureId: `cap_${id}`,
  timing: { kind: "auto" },
  mediaTrim: null,
  transition: "cut",
  videoFit: "smart-fit",
  ...patch
});

const sequence = (id: string, beats: SizzleSequenceBeat[]): SizzleScene => ({
  id,
  kind: "sequence",
  captureId: beats[0]?.captureId ?? "",
  scriptLine: "narration",
  narration: "narration",
  beats,
  durationOverrideSec: null,
  mediaTrim: null,
  audioSource: "voiceover",
  transition: "crossfade"
});

const simple = (id: string): SizzleScene => ({
  id,
  captureId: `cap_${id}`,
  scriptLine: "line",
  durationOverrideSec: null,
  mediaTrim: { startSec: 1, endSec: 4 },
  audioSource: "auto",
  transition: "crossfade"
});

describe("scene-ops", () => {
  test("moveSceneBy swaps neighbours and returns the input when out of range", () => {
    const scenes = [simple("a"), simple("b"), simple("c")];
    expect(moveSceneBy(scenes, 0, 1).map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(moveSceneBy(scenes, 0, -1)).toBe(scenes);
    expect(moveSceneBy(scenes, 2, 1)).toBe(scenes);
  });

  test("reorderSequenceBeatIn splices (not swaps) and reports no change for a self-drop", () => {
    const scenes = [sequence("s", [beat("a"), beat("b"), beat("c")])];
    const moved = reorderSequenceBeatIn(scenes, "s", 0, 2);
    expect(moved.changed).toBe(true);
    expect(moved.scenes[0]!.beats!.map((b) => b.id)).toEqual(["b", "c", "a"]);
    const same = reorderSequenceBeatIn(scenes, "s", 1, 1);
    expect(same.changed).toBe(false);
    expect(same.scenes).toBe(scenes);
    const oob = reorderSequenceBeatIn(scenes, "s", 0, 9);
    expect(oob.changed).toBe(false);
  });

  test("patchSequenceBeat re-applies the non-final-end rule after the edit", () => {
    const scenes = [
      sequence("s", [
        beat("a"),
        beat("b", { timing: { kind: "offset", startSec: 2, endSec: null } }),
        beat("c")
      ])
    ];
    // Giving a NON-final beat an explicit end is normalized away.
    const next = patchSequenceBeat(scenes, "s", "b", {
      timing: { kind: "offset", startSec: 2, endSec: 5 }
    });
    expect(next[0]!.beats![1]!.timing).toEqual({ kind: "offset", startSec: 2, endSec: null });
  });

  test("removeSequenceBeatFrom keeps at least one clip", () => {
    const two = [sequence("s", [beat("a"), beat("b")])];
    expect(removeSequenceBeatFrom(two, "s", "a")[0]!.beats!.map((b) => b.id)).toEqual(["b"]);
    const one = [sequence("s", [beat("a")])];
    expect(removeSequenceBeatFrom(one, "s", "a")[0]!.beats!.length).toBe(1);
  });

  test("convertSceneToSequence wraps a simple scene's capture + trim in one auto clip", () => {
    const next = convertSceneToSequence([simple("a")], "a");
    const scene = next[0]!;
    expect(scene.kind).toBe("sequence");
    expect(scene.narration).toBe("line");
    expect(scene.audioSource).toBe("voiceover");
    expect(scene.beats).toHaveLength(1);
    expect(scene.beats![0]).toMatchObject({
      captureId: "cap_a",
      timing: { kind: "auto" },
      mediaTrim: { startSec: 1, endSec: 4 }
    });
  });

  test("splitSceneIntoScenes keeps the first scene's id + narration and resets clip timing to auto", () => {
    const scenes = [
      sequence("s", [
        beat("a"),
        beat("b", { timing: { kind: "offset", startSec: 3, endSec: null }, videoFit: "loop" }),
        beat("c")
      ])
    ];
    const next = splitSceneIntoScenes(scenes, "s");
    expect(next).toHaveLength(3);
    expect(next[0]!.id).toBe("s");
    expect(next[0]!.narration).toBe("narration");
    expect(next[0]!.captureId).toBe("cap_a");
    expect(next[1]!.id).not.toBe("s");
    expect(next[1]!.narration).toBe("");
    expect(next[1]!.beats![0]).toMatchObject({ id: "b", timing: { kind: "auto" }, videoFit: "loop" });
    // A single-clip scene is left alone.
    const lone = [sequence("s", [beat("a")])];
    expect(splitSceneIntoScenes(lone, "s")).toEqual(lone);
  });
});

import {
  mergeSceneIntoPrevious,
  pseudoWordsFromText,
  refitSceneOffsets,
  sceneHasOffsetAnchors,
  splitSceneAtSec,
  splitTextAtWord
} from "../scene-ops";
import type { SizzleWordTiming } from "@pwrsnap/shared";

describe("scene-ops — multi-scene operations (plan PR 8)", () => {
  const phrase = (p: string, occurrence = 1, offsetSec = 0): SizzleSequenceBeat["timing"] => ({
    kind: "phrase",
    phrase: p,
    occurrence,
    offsetSec,
    durationSec: null
  });
  const narrated = (id: string, text: string, beats: SizzleSequenceBeat[], patch: Partial<SizzleScene> = {}): SizzleScene => ({
    ...sequence(id, beats),
    scriptLine: text,
    narration: text,
    ...patch
  });

  test("mergeSceneIntoPrevious: narration concatenates, the boundary clip pins to the merged-in first words, occurrences re-count, offsets shift", () => {
    const a = narrated("sa", "Open the Library to find the capture.", [beat("a1"), beat("a2", { timing: phrase("the", 2) })]);
    const b = narrated(
      "sb",
      "The Library keeps every capture.",
      [beat("b1"), beat("b2", { timing: phrase("capture", 1) }), beat("b3", { timing: { kind: "offset", startSec: 2, endSec: null } })],
      { transition: { type: "dip-black", durationSec: 0.3 } }
    );
    const next = mergeSceneIntoPrevious([a, b], "sb", { prevDurationSec: 4.5 });
    expect(next).toHaveLength(1);
    const merged = next[0]!;
    expect(merged.id).toBe("sa");
    expect(merged.narration).toBe("Open the Library to find the capture. The Library keeps every capture.");
    expect(merged.beats!.map((x) => x.id)).toEqual(["a1", "a2", "b1", "b2", "b3"]);
    // The boundary clip: "The Library" occurs twice across the merged text
    // ("the Library" in A, "The Library" in B) → grows to a unique phrase and
    // counts the one in A; it carries the former scene transition.
    const boundary = merged.beats![2]!;
    expect(boundary.timing).toEqual(phrase("The Library keeps", 1));
    expect(boundary.transition).toEqual({ type: "dip-black", durationSec: 0.3 });
    // "capture" occurs once in A → B's anchor becomes occurrence 2.
    expect(merged.beats![3]!.timing).toEqual(phrase("capture", 2));
    // Offsets shift by the previous scene's length.
    expect(merged.beats![4]!.timing).toEqual({ kind: "offset", startSec: 6.5, endSec: null });
    // A's own clips are untouched.
    expect(merged.beats![1]!.timing).toEqual(phrase("the", 2));
    // Nothing to merge into: the first scene, or a simple scene before it.
    expect(mergeSceneIntoPrevious([a, b], "sa", { prevDurationSec: 1 })).toEqual([a, b]);
    expect(mergeSceneIntoPrevious([simple("s0"), b], "sb", { prevDurationSec: 1 })).toHaveLength(2);
  });

  test("splitSceneAtSec: the script divides at the word spoken at the split; clips before stay, the rest rebase into a new scene", () => {
    const text = "Open the Library to find the capture, then share it.";
    // 10 words, one every 0.5 s: Open 0, the 0.5, Library 1, to 1.5, find 2, the 2.5, capture 3, then 3.5, share 4, it 4.5
    const words: SizzleWordTiming[] = text.split(" ").map((word, index) => ({
      index,
      word,
      normalized: word.toLowerCase().replace(/[^a-z0-9]/g, ""),
      startSec: index * 0.5,
      endSec: index * 0.5 + 0.4
    }));
    const scene = narrated("s1", text, [
      beat("c1"),
      beat("c2", { timing: phrase("find", 1) }),
      beat("c3", { timing: phrase("the", 2, 0.1) }),
      beat("c4", { timing: { kind: "offset", startSec: 4, endSec: null } })
    ]);
    // Resolved starts: c1 0, c2 2.0 ("find"), c3 2.6 ("the" #2 + 0.1), c4 4.0.
    const next = splitSceneAtSec([scene], "s1", 2.3, { words, clipStartsSec: [0, 2, 2.6, 4] });
    expect(next).toHaveLength(2);
    const [first, second] = next as [SizzleScene, SizzleScene];
    expect(first.id).toBe("s1");
    // The split falls before "the" (2.5 s) — word 5.
    expect(first.narration).toBe("Open the Library to find");
    expect(second.narration).toBe("the capture, then share it.");
    expect(first.beats!.map((b) => b.id)).toEqual(["c1", "c2"]);
    expect(second.beats!.map((b) => b.id)).toEqual(["c3", "c4"]);
    // The new scene's first clip is pinned at 0 (auto); "the" #2 would have
    // been occurrence 1 in the new scene anyway — it IS clip 0 now.
    expect(second.beats![0]!.timing).toEqual({ kind: "auto" });
    // The offset rebases against the new scene's ZERO — the first moved word
    // ("the" at 2.5 s), not the scrub point at 2.3 s. Rebasing by the
    // playhead would land it 0.2 s late, and the gap grows if you split in
    // a pause between sentences.
    expect(second.beats![1]!.timing).toEqual({ kind: "offset", startSec: 1.5, endSec: null });
    expect(second.transition).toBe("cut");
    expect(second.captureId).toBe("cap_c3");
    // Occurrence re-count: a phrase anchor in the moved half drops by its
    // count before the split.
    const scene2 = narrated("s2", text, [
      beat("d1"),
      beat("d2", { timing: phrase("the", 1) }),
      beat("d3", { timing: phrase("the", 2) })
    ]);
    const split2 = splitSceneAtSec([scene2], "s2", 1.2, { words, clipStartsSec: [0, 0.5, 2.5] });
    expect(split2).toHaveLength(2);
    expect(split2[1]!.beats!.map((b) => b.id)).toEqual(["d3"]); // lone → auto
    // No-ops: the split sits at the first word (nothing before it to keep), or past every word.
    expect(splitSceneAtSec([scene], "s1", 0, { words, clipStartsSec: [0, 2, 2.6, 4] })).toEqual([scene]);
    expect(splitSceneAtSec([scene], "s1", 9, { words, clipStartsSec: [0, 2, 2.6, 4] })).toEqual([scene]);
    // Estimated scene (no words): nothing is fabricated — no split.
    expect(splitSceneAtSec([scene], "s1", 2.3, { words: [], clipStartsSec: [0, 2, 2.6, 4] })).toEqual([scene]);
  });

  test("splitTextAtWord keeps punctuation with its word and trims the seam", () => {
    expect(splitTextAtWord("Open the Library, then share it.", 3)).toEqual(["Open the Library,", "then share it."]);
    expect(splitTextAtWord("one two", 0)).toEqual(["", "one two"]);
    expect(splitTextAtWord("one two", 5)).toEqual(["one two", ""]);
    expect(pseudoWordsFromText("It's the Library").map((w) => w.normalized)).toEqual(["its", "the", "library"]);
  });

  test("refitSceneOffsets scales only offsets, by new/old, and reports no change without any", () => {
    const scene = narrated("s1", "n", [
      beat("a"),
      beat("b", { timing: { kind: "offset", startSec: 3, endSec: null } }),
      beat("c", { timing: phrase("x") }),
      beat("d", { timing: { kind: "offset", startSec: 6, endSec: 9 } })
    ]);
    expect(sceneHasOffsetAnchors(scene)).toBe(true);
    const next = refitSceneOffsets([scene], "s1", 10, 8);
    expect(next[0]!.beats![1]!.timing).toEqual({ kind: "offset", startSec: 2.4, endSec: null });
    expect(next[0]!.beats![2]!.timing).toEqual(phrase("x"));
    expect(next[0]!.beats![3]!.timing).toEqual({ kind: "offset", startSec: 4.8, endSec: 7.2 });
    const none = narrated("s2", "n", [beat("a"), beat("b", { timing: phrase("x") })]);
    expect(sceneHasOffsetAnchors(none)).toBe(false);
    const input = [none];
    expect(refitSceneOffsets(input, "s2", 10, 8)).toBe(input);
    expect(refitSceneOffsets([scene], "s1", 0, 8)).toEqual([scene]);
  });
});
