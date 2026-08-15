import { describe, expect, test } from "vitest";
import {
  newSizzleSequenceBeat,
  newSizzleSequenceScene,
  sizzleProjectCaptureIds,
  sizzleProjectHasCapture,
  sizzleSceneCaptureIds,
  type SizzleScene
} from "@pwrsnap/shared";
import {
  appendCapturesToScenes,
  newSequenceScenesForCaptures,
  removeCaptureFromScenes
} from "../scene-edits";
import { SIZZLE_LIMITS } from "../../handlers/sizzle-validators";

function simple(id: string, captureId: string): SizzleScene {
  return {
    id,
    captureId,
    scriptLine: "",
    durationOverrideSec: null,
    mediaTrim: null,
    audioSource: "auto",
    transition: "crossfade"
  };
}

describe("newSizzleSequenceScene", () => {
  test("one scene, one voiceover, N auto clips in the given order", () => {
    const scene = newSizzleSequenceScene(["a", "b", "c"], { narration: "hi" });
    expect(scene.kind).toBe("sequence");
    expect(scene.captureId).toBe("a");
    expect(scene.narration).toBe("hi");
    expect(scene.scriptLine).toBe("hi");
    expect(scene.audioSource).toBe("voiceover");
    expect(scene.transition).toBe("crossfade");
    expect(scene.beats!.map((b) => b.captureId)).toEqual(["a", "b", "c"]);
    for (const beat of scene.beats!) {
      expect(beat).toMatchObject({
        timing: { kind: "auto" },
        mediaTrim: null,
        transition: "cut",
        videoFit: "smart-fit"
      });
      expect(beat.id).toMatch(/^bt_/);
    }
    expect(scene.id).toMatch(/^sc_/);
  });

  test("ids are unique across calls", () => {
    const a = newSizzleSequenceBeat("x");
    const b = newSizzleSequenceBeat("x");
    expect(a.id).not.toBe(b.id);
  });
});

describe("membership helpers", () => {
  test("sequence scenes report every clip; simple scenes report their capture", () => {
    const seq = newSizzleSequenceScene(["a", "b"]);
    expect(sizzleSceneCaptureIds(seq)).toEqual(["a", "b"]);
    expect(sizzleSceneCaptureIds(simple("s", "z"))).toEqual(["z"]);
    const all = sizzleProjectCaptureIds([seq, simple("s", "z")]);
    expect([...all].sort()).toEqual(["a", "b", "z"]);
    expect(sizzleProjectHasCapture([seq], "b")).toBe(true);
    expect(sizzleProjectHasCapture([seq], "nope")).toBe(false);
  });
});

describe("appendCapturesToScenes", () => {
  test("empty project → one new sequence scene", () => {
    const out = appendCapturesToScenes([], ["a", "b"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("sequence");
    expect(out[0]!.beats!.map((b) => b.captureId)).toEqual(["a", "b"]);
  });

  test("last scene is a sequence → clips join it, de-duped, order kept, narration untouched", () => {
    const seq = newSizzleSequenceScene(["a"], { narration: "n" });
    const out = appendCapturesToScenes([simple("s0", "z"), seq], ["z", "b", "a", "c", "b"]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(out[0]); // untouched simple scene stays first
    expect(out[1]!.narration).toBe("n");
    expect(out[1]!.beats!.map((b) => b.captureId)).toEqual(["a", "b", "c"]);
  });

  test("last scene is legacy simple → one new sequence scene is appended", () => {
    const out = appendCapturesToScenes([simple("s0", "a")], ["a", "b"]);
    expect(out).toHaveLength(2);
    expect(out[1]!.kind).toBe("sequence");
    expect(out[1]!.beats!.map((b) => b.captureId)).toEqual(["b"]);
  });

  test("nothing new → same scenes back (copy)", () => {
    const seq = newSizzleSequenceScene(["a"]);
    const out = appendCapturesToScenes([seq], ["a"]);
    expect(out).toEqual([seq]);
    expect(out).not.toBe([seq]);
  });
});

describe("per-scene clip cap", () => {
  const cap = SIZZLE_LIMITS.sequenceBeatsMax;
  const ids = (n: number, prefix = "c"): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  test("a fresh reel spills past the cap into further scenes instead of one unsavable scene", () => {
    const scenes = newSequenceScenesForCaptures(ids(cap + 5));
    expect(scenes).toHaveLength(2);
    expect(scenes[0]!.beats).toHaveLength(cap);
    expect(scenes[1]!.beats).toHaveLength(5);
    // Order is preserved across the split.
    expect(scenes[0]!.beats![0]!.captureId).toBe("c0");
    expect(scenes[1]!.beats![0]!.captureId).toBe(`c${cap}`);
    for (const scene of scenes) {
      expect(scene.beats!.length).toBeLessThanOrEqual(cap);
    }
  });

  test("appending fills the last scene only up to the cap, then spills", () => {
    const start = newSequenceScenesForCaptures(ids(cap - 2));
    const out = appendCapturesToScenes(start, ids(5, "n"));
    expect(out).toHaveLength(2);
    expect(out[0]!.beats).toHaveLength(cap);
    expect(out[1]!.beats).toHaveLength(3);
    for (const scene of out) {
      expect(scene.beats!.length).toBeLessThanOrEqual(cap);
    }
  });

  test("a full last scene is left alone and the whole batch spills", () => {
    const start = newSequenceScenesForCaptures(ids(cap));
    const out = appendCapturesToScenes(start, ids(2, "n"));
    expect(out).toHaveLength(2);
    expect(out[0]!.beats).toHaveLength(cap);
    expect(out[1]!.beats!.map((b) => b.captureId)).toEqual(["n0", "n1"]);
  });
});

describe("removeCaptureFromScenes", () => {
  test("pulls the first matching clip out of its scene; later duplicates stay", () => {
    const seq = newSizzleSequenceScene(["a", "b", "a"]);
    const out = removeCaptureFromScenes([seq], "a");
    expect(out).toHaveLength(1);
    expect(out[0]!.captureId).toBe("b");
    expect(out[0]!.beats!.map((b) => b.captureId)).toEqual(["b", "a"]);
  });

  test("a scene left with no clips is dropped", () => {
    const seq = newSizzleSequenceScene(["a"]);
    expect(removeCaptureFromScenes([simple("s", "z"), seq], "a")).toEqual([simple("s", "z")]);
  });

  test("simple scene match removes that scene only; absent capture is a no-op copy", () => {
    const scenes = [simple("s1", "a"), simple("s2", "a")];
    const out = removeCaptureFromScenes(scenes, "a");
    expect(out.map((s) => s.id)).toEqual(["s2"]);
    expect(removeCaptureFromScenes(scenes, "nope")).toEqual(scenes);
  });
});
