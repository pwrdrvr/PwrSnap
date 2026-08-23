import { describe, expect, test } from "vitest";
import type { SizzleSequencePreviewBeat } from "@pwrsnap/shared";
import {
  beatVisualWindow,
  kenBurnsDirection,
  stageFrameAt,
  transitionOverlapSec
} from "../preview-blend";

const beat = (
  id: string,
  startSec: number,
  endSec: number,
  transition: SizzleSequencePreviewBeat["transition"] = "cut"
): SizzleSequencePreviewBeat => ({
  beatId: id,
  captureId: `cap_${id}`,
  startSec,
  endSec,
  timing: { kind: "auto" },
  transition,
  videoFit: "smart-fit"
});

// a 0–4 (cut), b 4–6 (crossfade 0.4 s), c 6–8 (slide-left 0.5 s), d 8–10 (cut)
const BEATS = [
  beat("a", 0, 4),
  beat("b", 4, 6, "crossfade"),
  beat("c", 6, 8, { type: "slide-left", durationSec: 0.5 }),
  beat("d", 8, 10, "cut")
];

describe("stageFrameAt", () => {
  test("outside any transition window the active beat owns the stage alone", () => {
    expect(stageFrameAt(BEATS, 1)).toEqual({ activeIndex: 0, blend: null });
    expect(stageFrameAt(BEATS, 5)).toEqual({ activeIndex: 1, blend: null });
    // A cut into d: no window, the stage switches at 8.
    expect(stageFrameAt(BEATS, 7.9).blend).toBeNull();
    expect(stageFrameAt(BEATS, 8).activeIndex).toBe(3);
  });

  test("the last d seconds before a fade-like beat blend it in — the export's xfade overlaps BEFORE the audio start", () => {
    // crossfade 0.4 into b (starts at 4): window is [3.6, 4).
    expect(stageFrameAt(BEATS, 3.59).blend).toBeNull();
    const at = stageFrameAt(BEATS, 3.8);
    expect(at.activeIndex).toBe(0);
    expect(at.blend).toMatchObject({ incomingIndex: 1, type: "crossfade", durationSec: 0.4 });
    expect(at.blend?.startSec).toBeCloseTo(3.6, 6);
    expect(at.blend?.progress).toBeCloseTo(0.5, 6);
    // At 4.0 b owns the stage (no blend of its own yet — c's window is [5.5, 6)).
    expect(stageFrameAt(BEATS, 4)).toEqual({ activeIndex: 1, blend: null });
    const slide = stageFrameAt(BEATS, 5.75);
    expect(slide.blend?.type).toBe("slide-left");
    expect(slide.blend?.progress).toBeCloseTo(0.5, 6);
  });

  test("edges: before the first beat, past the last, and no beats", () => {
    expect(stageFrameAt(BEATS, -1).activeIndex).toBe(0);
    expect(stageFrameAt(BEATS, 99)).toEqual({ activeIndex: 3, blend: null });
    expect(stageFrameAt([], 1)).toEqual({ activeIndex: -1, blend: null });
  });
});

describe("visual windows + Ken Burns", () => {
  test("a fade-like transition extends the beat's visual at its head; a cut and beat 0 do not", () => {
    expect(transitionOverlapSec("crossfade", 1)).toBe(0.4);
    expect(transitionOverlapSec("crossfade", 0)).toBe(0); // nothing before beat 0
    expect(transitionOverlapSec("cut", 2)).toBe(0);
    expect(transitionOverlapSec({ type: "none", durationSec: 0 }, 2)).toBe(0);
    expect(beatVisualWindow(BEATS[1]!, 1)).toEqual({ startSec: 3.6, endSec: 6 });
    expect(beatVisualWindow(BEATS[3]!, 3)).toEqual({ startSec: 8, endSec: 10 });
    // Never before 0.
    expect(beatVisualWindow(beat("z", 0.2, 3, "crossfade"), 1).startSec).toBe(0);
  });

  test("even clips zoom in, odd clips zoom out (the composer's zoompan input parity)", () => {
    expect(kenBurnsDirection(0)).toBe("in");
    expect(kenBurnsDirection(1)).toBe("out");
    expect(kenBurnsDirection(2)).toBe("in");
  });
});
