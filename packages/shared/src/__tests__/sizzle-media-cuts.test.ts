// A reel clip plays its own trim window minus the capture's Library cuts.
// These pin the arithmetic every surface shares — the render planner,
// the duration estimate, the preview player and the inspector all call
// these functions, so they can never disagree about what a clip plays.

import { describe, expect, it } from "vitest";
import type { SizzleScene, VideoRange } from "../protocol";
import {
  SIZZLE_SCENE_MEDIA_MAX_SEC,
  sizzleMediaSourceTimeSec,
  sizzleMediaSpans,
  sizzleMediaSpansDurationSec,
  sizzleMediaSpansHaveCuts,
  sizzleMediaSpansPrefix,
  sizzleUsesCaptureCuts
} from "../sizzle-media-trim";
import { estimateSizzleSceneDurationSec } from "../sizzle-reel-duration";

// A 40 s take cut down to four parts: 0–3.5, 11.3–16.3, 19.3–22.1, 27.3–32.1.
const CUT_EDIT: VideoRange[] = [
  { start: 0, end: 3.5 },
  { start: 11.3, end: 16.3 },
  { start: 19.3, end: 22.1 },
  { start: 27.3, end: 32.1 }
];

describe("sizzleUsesCaptureCuts", () => {
  it("is on unless the clip opted out", () => {
    expect(sizzleUsesCaptureCuts({})).toBe(true);
    expect(sizzleUsesCaptureCuts({ useCaptureCuts: true })).toBe(true);
    expect(sizzleUsesCaptureCuts({ useCaptureCuts: false })).toBe(false);
  });
});

describe("sizzleMediaSpans", () => {
  it("removes the capture's interior cuts from the clip's window", () => {
    const spans = sizzleMediaSpans({
      trim: { startSec: 0, endSec: 32.1 },
      segments: CUT_EDIT,
      useCaptureCuts: true
    });
    expect(spans).toEqual(CUT_EDIT);
    expect(sizzleMediaSpansDurationSec(spans)).toBeCloseTo(16.1, 6);
    expect(sizzleMediaSpansHaveCuts(spans)).toBe(true);
  });

  it("keeps the clip's own trim as the outer bound — only interior cuts apply", () => {
    // The clip starts mid-part and ends mid-part; the Library's outer
    // range (0 → 32.1) says nothing about where the clip starts or ends.
    const spans = sizzleMediaSpans({
      trim: { startSec: 2, endSec: 21 },
      segments: CUT_EDIT,
      useCaptureCuts: true
    });
    expect(spans).toEqual([
      { start: 2, end: 3.5 },
      { start: 11.3, end: 16.3 },
      { start: 19.3, end: 21 }
    ]);
  });

  it("does not re-trim a clip whose window reaches past the Library's in/out", () => {
    // Library trimmed to 5–15 with no interior cut: nothing to skip, and
    // the clip keeps its own wider 0–20 window as it always has.
    const spans = sizzleMediaSpans({
      trim: { startSec: 0, endSec: 20 },
      segments: [{ start: 5, end: 15 }],
      useCaptureCuts: true
    });
    expect(spans).toEqual([{ start: 0, end: 20 }]);
  });

  it("plays one span equal to the trim when the clip opts out", () => {
    const spans = sizzleMediaSpans({
      trim: { startSec: 0, endSec: 32.1 },
      segments: CUT_EDIT,
      useCaptureCuts: false
    });
    expect(spans).toEqual([{ start: 0, end: 32.1 }]);
    expect(sizzleMediaSpansHaveCuts(spans)).toBe(false);
  });

  it("treats a split (touching spans) as no cut", () => {
    const spans = sizzleMediaSpans({
      trim: { startSec: 0, endSec: 10 },
      segments: [
        { start: 0, end: 4 },
        { start: 4, end: 10 }
      ],
      useCaptureCuts: true
    });
    expect(spans).toEqual([{ start: 0, end: 10 }]);
  });

  it("plays the window uncut rather than nothing when a cut swallows all of it", () => {
    const spans = sizzleMediaSpans({
      trim: { startSec: 5, endSec: 9 },
      segments: CUT_EDIT,
      useCaptureCuts: true
    });
    expect(spans).toEqual([{ start: 5, end: 9 }]);
  });

  it("drops a sliver shorter than the model's minimum span", () => {
    const spans = sizzleMediaSpans({
      trim: { startSec: 3.45, endSec: 16.3 },
      segments: CUT_EDIT,
      useCaptureCuts: true
    });
    expect(spans).toEqual([{ start: 11.3, end: 16.3 }]);
  });
});

describe("sizzleMediaSpans maxSec", () => {
  it("caps the KEPT footage, not the window", () => {
    // A 90 s window with 60 s cut out keeps 30 s — under the cap, whole.
    const spans = sizzleMediaSpans({
      trim: { startSec: 0, endSec: 90 },
      segments: [
        { start: 0, end: 10 },
        { start: 70, end: 90 }
      ],
      useCaptureCuts: true,
      maxSec: SIZZLE_SCENE_MEDIA_MAX_SEC
    });
    expect(sizzleMediaSpansDurationSec(spans)).toBeCloseTo(30, 6);
  });

  it("keeps only the first maxSec of an uncut long window", () => {
    const spans = sizzleMediaSpans({
      trim: { startSec: 5, endSec: 95 },
      segments: null,
      useCaptureCuts: true,
      maxSec: SIZZLE_SCENE_MEDIA_MAX_SEC
    });
    expect(spans).toEqual([{ start: 5, end: 65 }]);
  });
});

describe("sizzleMediaSpansPrefix", () => {
  it("returns the first N seconds of kept picture, ending mid-span", () => {
    expect(sizzleMediaSpansPrefix(CUT_EDIT, 5)).toEqual([
      { start: 0, end: 3.5 },
      { start: 11.3, end: 12.8 }
    ]);
  });

  it("returns every span when N covers the edit", () => {
    expect(sizzleMediaSpansPrefix(CUT_EDIT, 99)).toEqual(CUT_EDIT);
  });
});

describe("sizzleMediaSourceTimeSec", () => {
  it("maps an offset into the edit to the source instant it shows", () => {
    expect(sizzleMediaSourceTimeSec(CUT_EDIT, 1)).toBeCloseTo(1, 6);
    // 3.5 s of the first part, then 1 s into the second.
    expect(sizzleMediaSourceTimeSec(CUT_EDIT, 4.5)).toBeCloseTo(12.3, 6);
    // The instant a part ends is the next part's start.
    expect(sizzleMediaSourceTimeSec(CUT_EDIT, 3.5)).toBeCloseTo(11.3, 6);
  });

  it("clamps past the end to the last kept instant", () => {
    expect(sizzleMediaSourceTimeSec(CUT_EDIT, 100)).toBeCloseTo(32.1, 6);
  });
});

describe("estimateSizzleSceneDurationSec with Library cuts", () => {
  const scene = (patch: Partial<SizzleScene> = {}): SizzleScene => ({
    id: "sc_1",
    captureId: "cap_v",
    scriptLine: "",
    durationOverrideSec: null,
    mediaTrim: { startSec: 0, endSec: 32.1 },
    audioSource: "native",
    transition: "crossfade",
    ...patch
  });
  const context = {
    capture: {
      kind: "video" as const,
      video: { durationSec: 40, defaultRange: { start: 0, end: 32.1 }, segments: CUT_EDIT }
    }
  };

  it("sizes a native-audio video scene from the footage it keeps", () => {
    const estimate = estimateSizzleSceneDurationSec(scene(), context);
    expect(estimate.durationSec).toBeCloseTo(16.1, 6);
    expect(estimate.exact).toBe(true);
  });

  it("sizes an opted-out scene from its whole trim", () => {
    const estimate = estimateSizzleSceneDurationSec(scene({ useCaptureCuts: false }), context);
    expect(estimate.durationSec).toBeCloseTo(32.1, 6);
  });
});
