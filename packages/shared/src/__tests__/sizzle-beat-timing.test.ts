import { describe, expect, it } from "vitest";
import { distributeSequenceBeatStarts } from "../protocol";

describe("distributeSequenceBeatStarts", () => {
  it("evenly divides a run of auto beats between two anchors (AE1)", () => {
    // index 0 = head (always 0), anchor@2, 3 autos, anchor@10.
    expect(distributeSequenceBeatStarts([0, 2, null, null, null, 10], 18)).toEqual([
      0, 2, 4, 6, 8, 10
    ]);
  });

  it("pins index 0 to 0 and ignores its anchor value (D3-revised)", () => {
    // A non-zero anchor at index 0 is parked, not honored — the first beat
    // always covers narration from the start.
    expect(distributeSequenceBeatStarts([5, null, 10], 12)[0]).toBe(0);
  });

  it("splits trailing autos to the timeline end (AE6)", () => {
    // head, anchor@4, then 2 trailing autos → [4,10] divided into 3.
    expect(distributeSequenceBeatStarts([0, 4, null, null], 10)).toEqual([0, 4, 6, 8]);
  });

  it("spreads an all-auto sequence evenly (AE8)", () => {
    expect(distributeSequenceBeatStarts([null, null, null, null], 8)).toEqual([0, 2, 4, 6]);
  });

  it("clamps out-of-order anchors monotonically — never a negative slice (AE10)", () => {
    // anchor@8 then anchor@2 (out of order): the later anchor is clamped up to
    // 8 so slices stay >= 0.
    const starts = distributeSequenceBeatStarts([0, 8, 2, null], 10);
    expect(starts).toEqual([0, 8, 8, 9]);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]!).toBeGreaterThanOrEqual(starts[i - 1]!);
    }
  });

  it("handles degenerate sizes", () => {
    expect(distributeSequenceBeatStarts([], 5)).toEqual([]);
    expect(distributeSequenceBeatStarts([null], 5)).toEqual([0]);
    expect(distributeSequenceBeatStarts([0], 5)).toEqual([0]);
  });

  it("never exceeds the duration and rounds to milliseconds", () => {
    const starts = distributeSequenceBeatStarts([null, null, null], 1);
    expect(starts).toEqual([0, 0.333, 0.667]);
    for (const s of starts) expect(s).toBeLessThanOrEqual(1);
  });
});
