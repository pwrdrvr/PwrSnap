import { describe, expect, it } from "vitest";
import {
  estimateNarrationDurationSec,
  estimateSequenceTimelineDurationSec,
  estimateSizzleReelDurationSec,
  estimateSizzleSceneDurationSec,
  formatSizzleDuration,
  SIZZLE_IMAGE_SCENE_DEFAULT_SEC,
  type SizzleSceneDurationContext
} from "../sizzle-reel-duration";
import { newSizzleSequenceScene, type SizzleScene, type SizzleTransition } from "../protocol";

function simpleScene(overrides: Partial<SizzleScene> = {}): SizzleScene {
  return {
    id: "sc_1",
    kind: "simple",
    captureId: "cap_1",
    scriptLine: "",
    durationOverrideSec: null,
    mediaTrim: null,
    audioSource: "auto",
    transition: "cut",
    ...overrides
  };
}

const imageCapture: SizzleSceneDurationContext["capture"] = { kind: "image", video: null };

function videoCapture(
  durationSec: number,
  range: { start: number; end: number } = { start: 0, end: durationSec }
): SizzleSceneDurationContext["capture"] {
  return { kind: "video", video: { durationSec, defaultRange: range } };
}

describe("formatSizzleDuration", () => {
  it("formats as m:ss with a zero-padded seconds field", () => {
    expect(formatSizzleDuration(42)).toBe("0:42");
    expect(formatSizzleDuration(67)).toBe("1:07");
    expect(formatSizzleDuration(750)).toBe("12:30");
  });

  it("rounds to the nearest second rather than truncating", () => {
    // 41.6s truncated reads "0:41" but renders to 42s — that reads as a bug.
    expect(formatSizzleDuration(41.6)).toBe("0:42");
    expect(formatSizzleDuration(41.4)).toBe("0:41");
    expect(formatSizzleDuration(41.5)).toBe("0:42");
  });

  it("carries the rounding boundary into the minutes field", () => {
    expect(formatSizzleDuration(59.4)).toBe("0:59");
    expect(formatSizzleDuration(59.5)).toBe("1:00");
    expect(formatSizzleDuration(119.7)).toBe("2:00");
  });

  it("clamps empty, negative and non-finite input to 0:00", () => {
    expect(formatSizzleDuration(0)).toBe("0:00");
    expect(formatSizzleDuration(-3)).toBe("0:00");
    expect(formatSizzleDuration(Number.NaN)).toBe("0:00");
    expect(formatSizzleDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
  });

  it("leaves minutes unbounded past an hour", () => {
    expect(formatSizzleDuration(3600)).toBe("60:00");
  });
});

describe("estimateNarrationDurationSec", () => {
  it("scales with word count at the assumed rate", () => {
    expect(estimateNarrationDurationSec("one two three four")).toBeCloseTo(1.5, 6);
    expect(estimateNarrationDurationSec("a ".repeat(160).trim())).toBeCloseTo(60, 6);
  });

  it("counts dash-joined compounds as the words they are spoken as", () => {
    // "copy-to-clipboard" is one whitespace token but three spoken words;
    // technical narration is full of these and whitespace-only splitting
    // under-counts it.
    expect(estimateNarrationDurationSec("copy-to-clipboard")).toBeCloseTo(
      estimateNarrationDurationSec("copy to clipboard"),
      6
    );
    expect(estimateNarrationDurationSec("buttons—and it")).toBeCloseTo(
      estimateNarrationDurationSec("buttons and it"),
      6
    );
  });

  it("returns zero for empty or whitespace-only text", () => {
    expect(estimateNarrationDurationSec("")).toBe(0);
    expect(estimateNarrationDurationSec("   \n  ")).toBe(0);
  });

  it("ignores leading and trailing whitespace when counting", () => {
    expect(estimateNarrationDurationSec("  one two  ")).toBeCloseTo(
      estimateNarrationDurationSec("one two"),
      6
    );
  });
});

describe("estimateSequenceTimelineDurationSec", () => {
  it("is the same length the scene estimate reports, so the strip and the button agree", () => {
    // The editor's idle beat strip and the Render button both call this.
    // If they ever diverge, one surface is lying about the same scene.
    const scene = newSizzleSequenceScene(["a", "b", "c"], {
      narration: "one two three four five six seven eight"
    });
    expect(estimateSequenceTimelineDurationSec(scene)).toBeCloseTo(
      estimateSizzleSceneDurationSec(scene, { capture: imageCapture }).durationSec,
      6
    );
  });

  it("does not fall back to the clip count", () => {
    // Regression guard: 8 clips, 4 words. Clip count would say 8s.
    const scene = newSizzleSequenceScene(
      ["a", "b", "c", "d", "e", "f", "g", "h"],
      { narration: "one two three four" }
    );
    expect(estimateSequenceTimelineDurationSec(scene)).toBeCloseTo(1.5, 6);
  });

  it("floors at one second and takes the override as a floor too", () => {
    const empty = newSizzleSequenceScene(["a"], { narration: "" });
    expect(estimateSequenceTimelineDurationSec(empty)).toBe(1);
    expect(
      estimateSequenceTimelineDurationSec({ ...empty, durationOverrideSec: 12 })
    ).toBe(12);
  });
});

describe("estimateSizzleSceneDurationSec — sequence scenes", () => {
  it("is exact when a cached preview plan is supplied", () => {
    const scene = newSizzleSequenceScene(["a", "b", "c"], { narration: "hello" });
    expect(
      estimateSizzleSceneDurationSec(scene, {
        capture: imageCapture,
        sequencePlanDurationSec: 8.4
      })
    ).toEqual({ durationSec: 8.4, exact: true });
  });

  it("is exact from a cached narration length, with the override as a floor", () => {
    const scene = newSizzleSequenceScene(["a", "b"], { narration: "hello" });
    expect(
      estimateSizzleSceneDurationSec(scene, {
        capture: imageCapture,
        narrationDurationSec: 19
      })
    ).toEqual({ durationSec: 19, exact: true });
    expect(
      estimateSizzleSceneDurationSec(
        { ...scene, durationOverrideSec: 25 },
        { capture: imageCapture, narrationDurationSec: 19 }
      )
      // planSequenceTimeline floors at the override but never truncates
      // narration, so the longer of the two wins.
    ).toEqual({ durationSec: 25, exact: true });
  });

  it("estimates from the narration's word count, not the clip count", () => {
    // Three clips, one long narration — clip count says 3s, the script
    // says ~19s, and the script is the thing that drives the render.
    const narration =
      "Fixing this layout bug took three passes. The first invented a new style " +
      "for the copy-to-clipboard buttons—and it wasn't good. The second stopped " +
      "the text from squishing, but didn't restore the original look. The third " +
      "finally brought the buttons back to the original style, with the layout " +
      "just right.";
    const scene = newSizzleSequenceScene(["a", "b", "c"], { narration });
    const result = estimateSizzleSceneDurationSec(scene, { capture: imageCapture });
    expect(result.exact).toBe(false);
    // This script synthesized to 19.0s on tts-1 — the calibration sample
    // behind SIZZLE_ESTIMATED_NARRATION_WPM. Hold the estimate to within
    // 15% of it so a constant change that breaks the fit gets caught.
    expect(result.durationSec).toBeGreaterThan(19 * 0.85);
    expect(result.durationSec).toBeLessThan(19 * 1.15);
  });

  it("prefers a duration override over the narration estimate", () => {
    const scene = {
      ...newSizzleSequenceScene(["a", "b"], { narration: "hello" }),
      durationOverrideSec: 9
    };
    expect(estimateSizzleSceneDurationSec(scene, { capture: imageCapture })).toEqual({
      durationSec: 9,
      exact: false
    });
  });

  it("floors the fallback at one second for a beatless scene", () => {
    const scene: SizzleScene = { ...simpleScene({ kind: "sequence" }), beats: [] };
    expect(estimateSizzleSceneDurationSec(scene, { capture: imageCapture })).toEqual({
      durationSec: 1,
      exact: false
    });
  });
});

describe("estimateSizzleSceneDurationSec — simple scenes", () => {
  it("uses the video trim for a native-audio scene, exactly", () => {
    const scene = simpleScene({
      audioSource: "native",
      mediaTrim: { startSec: 2, endSec: 7.5 }
    });
    expect(estimateSizzleSceneDurationSec(scene, { capture: videoCapture(30) })).toEqual({
      durationSec: 5.5,
      exact: true
    });
  });

  it("clamps a trim that runs past the source, matching the render path", () => {
    const scene = simpleScene({
      audioSource: "muted",
      mediaTrim: { startSec: 1, endSec: 90 }
    });
    expect(estimateSizzleSceneDurationSec(scene, { capture: videoCapture(10) })).toEqual({
      durationSec: 9,
      exact: true
    });
  });

  it("adds the narration tail pad once a voiceover has been measured", () => {
    const scene = simpleScene({ audioSource: "voiceover", scriptLine: "hi" });
    expect(
      estimateSizzleSceneDurationSec(scene, {
        capture: videoCapture(30, { start: 0, end: 4 }),
        voiceoverDurationSec: 6
      })
    ).toEqual({ durationSec: 6.35, exact: true });
  });

  it("keeps the trim when a measured voiceover fits inside it", () => {
    const scene = simpleScene({ audioSource: "voiceover", scriptLine: "hi" });
    expect(
      estimateSizzleSceneDurationSec(scene, {
        capture: videoCapture(30, { start: 0, end: 10 }),
        voiceoverDurationSec: 2
      })
    ).toEqual({ durationSec: 10, exact: true });
  });

  it("extends an unmeasured video scene past its trim when the script is long", () => {
    const scene = simpleScene({
      audioSource: "voiceover",
      scriptLine: "one two three four five six seven eight nine ten eleven twelve"
    });
    const result = estimateSizzleSceneDurationSec(scene, {
      capture: videoCapture(30, { start: 0, end: 4 })
    });
    expect(result.exact).toBe(false);
    // 12 words at 160 wpm = 4.5s + 0.35s pad, which overruns the 4s trim.
    expect(result.durationSec).toBeCloseTo(4.85, 6);
  });

  it("estimates an unmeasured image scene from its script, flagged estimated", () => {
    // `auto` on an image resolves to voiceover, and a still has no
    // intrinsic length — the script is the only signal.
    const scene = simpleScene({ scriptLine: "one two three four five six seven eight" });
    const result = estimateSizzleSceneDurationSec(scene, { capture: imageCapture });
    expect(result.exact).toBe(false);
    // 8 words at 160 wpm = 3.0s, plus the 0.35s narration tail pad.
    expect(result.durationSec).toBeCloseTo(3.35, 6);
  });

  it("gives an empty-script image scene the image default rather than ~0s", () => {
    const scene = simpleScene({ scriptLine: "" });
    expect(estimateSizzleSceneDurationSec(scene, { capture: imageCapture })).toEqual({
      durationSec: SIZZLE_IMAGE_SCENE_DEFAULT_SEC,
      exact: false
    });
  });

  it("keeps an unmeasured video voiceover scene at its trim when the script is short", () => {
    // The render holds the last frame only if narration OVERRUNS the
    // clip; a short script leaves the trim in charge.
    const scene = simpleScene({ audioSource: "voiceover", scriptLine: "two words" });
    const result = estimateSizzleSceneDurationSec(scene, {
      capture: videoCapture(30, { start: 0, end: 10 })
    });
    expect(result).toEqual({ durationSec: 10, exact: false });
  });

  it("is exact for a muted image scene with an override", () => {
    const scene = simpleScene({ audioSource: "muted", durationOverrideSec: 6 });
    expect(estimateSizzleSceneDurationSec(scene, { capture: imageCapture })).toEqual({
      durationSec: 6,
      exact: true
    });
  });

  it("is estimated when the capture record has not loaded", () => {
    const scene = simpleScene({ audioSource: "muted", durationOverrideSec: 6 });
    expect(estimateSizzleSceneDurationSec(scene, { capture: null })).toEqual({
      durationSec: 6,
      exact: false
    });
  });
});

describe("estimateSizzleReelDurationSec", () => {
  const exactSequence = (
    id: string,
    transition: SizzleTransition
  ): SizzleScene => ({
    ...newSizzleSequenceScene(["a"], { narration: "x", transition }),
    id
  });

  it("reports zero and exact for an empty reel", () => {
    expect(estimateSizzleReelDurationSec([], () => ({ capture: null }))).toEqual({
      totalSec: 0,
      exact: true,
      sceneCount: 0
    });
  });

  it("sums scenes joined by hard cuts", () => {
    const scenes = [exactSequence("a", "cut"), exactSequence("b", "cut")];
    const plans: Record<string, number> = { a: 10, b: 12 };
    const result = estimateSizzleReelDurationSec(scenes, (scene) => ({
      capture: null,
      sequencePlanDurationSec: plans[scene.id]
    }));
    expect(result).toEqual({ totalSec: 22, exact: true, sceneCount: 2 });
  });

  it("gives back the crossfade overlap at each fade boundary", () => {
    // The composer splices an `xfade` per fade boundary, so the chain is
    // shorter than the sum by the fade duration — 0.4s each here.
    const scenes = [
      exactSequence("a", "crossfade"),
      exactSequence("b", "crossfade"),
      exactSequence("c", "crossfade")
    ];
    const plans: Record<string, number> = { a: 10, b: 10, c: 10 };
    const result = estimateSizzleReelDurationSec(scenes, (scene) => ({
      capture: null,
      sequencePlanDurationSec: plans[scene.id]
    }));
    // Scene 0's transition is ignored (nothing precedes it): 30 - 0.4 * 2.
    expect(result.totalSec).toBeCloseTo(29.2, 6);
    expect(result.exact).toBe(true);
  });

  it("clamps a fade longer than the scene it fades into", () => {
    const scenes = [
      exactSequence("a", "cut"),
      { ...exactSequence("b", { type: "crossfade", durationSec: 5 }) }
    ];
    const plans: Record<string, number> = { a: 10, b: 2 };
    const result = estimateSizzleReelDurationSec(scenes, (scene) => ({
      capture: null,
      sequencePlanDurationSec: plans[scene.id]
    }));
    // Overlap clamps to the incoming scene's 2s, not the requested 5s.
    expect(result.totalSec).toBeCloseTo(10, 6);
  });

  it("marks the whole reel estimated when any single scene is", () => {
    const scenes = [exactSequence("a", "cut"), exactSequence("b", "cut")];
    const result = estimateSizzleReelDurationSec(scenes, (scene) =>
      scene.id === "a"
        ? { capture: null, sequencePlanDurationSec: 10 }
        : { capture: null }
    );
    // Scene b has one beat and no cached plan → 1s fallback.
    expect(result).toEqual({ totalSec: 11, exact: false, sceneCount: 2 });
  });

  it("mixes exact and estimated scenes into one total", () => {
    const scenes = [
      exactSequence("a", "cut"),
      simpleScene({ id: "b", audioSource: "muted", durationOverrideSec: 4 }),
      exactSequence("c", "crossfade")
    ];
    const result = estimateSizzleReelDurationSec(scenes, (scene) => {
      if (scene.id === "a") return { capture: null, sequencePlanDurationSec: 12.5 };
      if (scene.id === "b") return { capture: imageCapture };
      return { capture: null };
    });
    // 12.5 (exact plan) + 4 (exact override) + 1 (estimated fallback) - 0.4 fade.
    expect(result.totalSec).toBeCloseTo(17.1, 6);
    expect(result.exact).toBe(false);
    expect(result.sceneCount).toBe(3);
  });
});
