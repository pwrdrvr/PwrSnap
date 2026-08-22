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
