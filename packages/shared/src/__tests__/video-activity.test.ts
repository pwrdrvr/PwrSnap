import { describe, expect, it } from "vitest";
import {
  activityLevelOfFraction,
  activityLevelOfMagnitude,
  decodeActivityMagnitude,
  encodeActivityMagnitude,
  videoActivityLevelString,
  videoActivityRuns,
  videoStillCuts,
  videoStillSpans,
  type VideoActivityTrack
} from "../video-activity";

// Fractions measured on a real 60 s browser recording (see the module
// header): spinner, cursor, panel update, page change.
const SPINNER = 0.00009;
const CURSOR = 0.0004;
const PANEL = 0.03;
const PAGE = 0.9;

function track(fractions: number[], sampleHz = 5): VideoActivityTrack {
  return { sampleHz, magnitudes: fractions.map(encodeActivityMagnitude) };
}

describe("magnitude encoding", () => {
  it("round-trips within a few percent across five decades", () => {
    for (const f of [1e-5, 1e-4, 0.00123, 0.05, 0.5, 1]) {
      const back = decodeActivityMagnitude(encodeActivityMagnitude(f));
      expect(Math.abs(back - f) / f).toBeLessThan(0.03);
    }
    expect(encodeActivityMagnitude(0)).toBe(0);
    expect(decodeActivityMagnitude(0)).toBe(0);
    expect(encodeActivityMagnitude(1e-9)).toBe(1);
    expect(encodeActivityMagnitude(1)).toBe(255);
  });

  it("levels the measured reference points the way a person would", () => {
    expect(activityLevelOfFraction(SPINNER)).toBe(0);
    expect(activityLevelOfFraction(CURSOR)).toBe(1);
    expect(activityLevelOfFraction(PANEL)).toBe(2);
    expect(activityLevelOfFraction(PAGE)).toBe(3);
    // And they survive the byte encoding.
    expect(activityLevelOfMagnitude(encodeActivityMagnitude(SPINNER))).toBe(0);
    expect(activityLevelOfMagnitude(encodeActivityMagnitude(PAGE))).toBe(3);
  });
});

describe("level string and runs", () => {
  const t = track([0, 0, SPINNER, CURSOR, CURSOR, PAGE, 0, 0, 0, 0]);

  it("renders one digit per sample", () => {
    expect(videoActivityLevelString(t)).toBe("0001130000");
  });

  it("run-length encodes the levels", () => {
    expect(videoActivityRuns(t)).toEqual({
      resolutionSec: 0.2,
      runs: [
        { start: 0, end: 0.6, level: 0 },
        { start: 0.6, end: 1, level: 1 },
        { start: 1, end: 1.2, level: 3 },
        { start: 1.2, end: 2, level: 0 }
      ]
    });
  });

  it("pools into wider buckets, busiest level winning, when runs overflow", () => {
    const noisy = track(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0 : PAGE)));
    const { resolutionSec, runs } = videoActivityRuns(noisy, { maxRuns: 5 });
    expect(resolutionSec).toBeGreaterThan(0.2);
    expect(runs.length).toBeLessThanOrEqual(5);
    expect(runs.every((r) => r.level === 3)).toBe(true);
  });
});

describe("still spans and cuts", () => {
  // 2 s still head, a change, 6 s still, a cursor wiggle mid-way, tail.
  const fractions = [
    ...Array(10).fill(SPINNER), // 0–2 s
    PAGE, // 2–2.2
    ...Array(15).fill(0), // 2.2–5.2
    CURSOR, // 5.2–5.4
    ...Array(15).fill(0), // 5.4–8.4
    PANEL, // 8.4–8.6
    ...Array(20).fill(0) // 8.6–12.6
  ];
  const t = track(fractions);

  it("finds strict still stretches", () => {
    expect(videoStillSpans(t, { minStillSec: 2 })).toEqual([
      { start: 0, end: 2 },
      { start: 2.2, end: 5.2 },
      { start: 5.4, end: 8.4 },
      { start: 8.6, end: 12.6 }
    ]);
  });

  it("can treat cursor movement as still", () => {
    expect(videoStillSpans(t, { minStillSec: 5, maxLevel: 1 })).toEqual([{ start: 2.2, end: 8.4 }]);
  });

  it("pads cuts next to changes, runs them to the clip edges", () => {
    expect(videoStillCuts(t, { minStillSec: 2, paddingSec: 0.5, durationSec: 13 })).toEqual([
      { start: 0, end: 1.5 },
      { start: 2.7, end: 4.7 },
      { start: 5.9, end: 7.9 },
      { start: 9.1, end: 13 }
    ]);
  });
});
