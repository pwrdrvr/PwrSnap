import { describe, expect, test } from "vitest";
import {
  clampRange,
  exportEyebrowLabel,
  exportRangeLabel,
  formatSpan,
  formatTimecode,
  formatTimecodeShort,
  fullRange,
  isFullRange,
  isValidRange,
  MIN_RANGE_SEC,
  pxToSec,
  roundTime,
  secToPx,
  stepTime,
  tickMarks,
  trimLabel
} from "../video-range";

describe("formatTimecode", () => {
  test("m:ss.d with floored tenths", () => {
    expect(formatTimecode(0)).toBe("0:00.0");
    expect(formatTimecode(3.4)).toBe("0:03.4");
    expect(formatTimecode(3.49)).toBe("0:03.4");
    expect(formatTimecode(16)).toBe("0:16.0");
    expect(formatTimecode(62.05)).toBe("1:02.0");
    expect(formatTimecode(600)).toBe("10:00.0");
  });

  test("never goes negative / NaN", () => {
    expect(formatTimecode(-2)).toBe("0:00.0");
    expect(formatTimecode(Number.NaN)).toBe("0:00.0");
  });

  test("short form rounds to seconds", () => {
    expect(formatTimecodeShort(3.4)).toBe("0:03");
    expect(formatTimecodeShort(11.2)).toBe("0:11");
    expect(formatTimecodeShort(59.6)).toBe("1:00");
  });

  test("span label drops the decimal when whole", () => {
    expect(formatSpan(7.8)).toBe("7.8 s");
    expect(formatSpan(8)).toBe("8 s");
    expect(formatSpan(8.04)).toBe("8 s");
    expect(formatSpan(7.8, 0)).toBe("8 s");
  });
});

describe("labels", () => {
  test("trim eyebrow", () => {
    expect(trimLabel({ start: 3.4, end: 11.2 })).toBe("TRIM 0:03.4 – 0:11.2 · 7.8 s");
  });

  test("export eyebrow is bare EXPORT for the full clip / null", () => {
    expect(exportEyebrowLabel(null, 16)).toBe("EXPORT");
    expect(exportEyebrowLabel({ start: 0, end: 16 }, 16)).toBe("EXPORT");
    expect(exportEyebrowLabel({ start: 0.01, end: 15.98 }, 16)).toBe("EXPORT");
  });

  test("export eyebrow shows the range when trimmed", () => {
    expect(exportEyebrowLabel({ start: 3.4, end: 11.2 }, 16)).toBe("EXPORT · 0:03–0:11 (8 s)");
    expect(exportEyebrowLabel({ start: 0, end: 8 }, 16)).toBe("EXPORT · 0:00–0:08 (8 s)");
    expect(exportRangeLabel({ start: 3.4, end: 11.2 }, 16)).toBe("0:03–0:11 (8 s)");
    expect(exportRangeLabel({ start: 0, end: 16 }, 16)).toBeNull();
    expect(exportRangeLabel(null, 16)).toBeNull();
  });
});

describe("clampRange / isFullRange", () => {
  test("clamps into [0, duration] and rounds to ms", () => {
    expect(clampRange({ start: -1, end: 99 }, 16)).toEqual({ start: 0, end: 16 });
    expect(clampRange({ start: 1.23456, end: 4.56789 }, 16)).toEqual({ start: 1.235, end: 4.568 });
  });

  test("enforces the minimum gap by pushing end out, or start in at the tail", () => {
    expect(clampRange({ start: 5, end: 5 }, 16)).toEqual({ start: 5, end: 5 + MIN_RANGE_SEC });
    expect(clampRange({ start: 16, end: 16 }, 16)).toEqual({
      start: roundTime(16 - MIN_RANGE_SEC),
      end: 16
    });
    // end < start never swaps — end is pulled to start then pushed by MIN.
    expect(clampRange({ start: 8, end: 2 }, 16)).toEqual({ start: 8, end: 8.1 });
  });

  test("full range detection tolerates tiny drift", () => {
    expect(isFullRange({ start: 0, end: 16 }, 16)).toBe(true);
    expect(isFullRange({ start: 0.02, end: 15.97 }, 16)).toBe(true);
    expect(isFullRange({ start: 0.5, end: 16 }, 16)).toBe(false);
    // Full range keeps the exact duration so a reset re-keys onto the
    // recorder-seeded range (export cache hit).
    expect(fullRange(16.0333333)).toEqual({ start: 0, end: 16.0333333 });
    expect(isValidRange({ start: 0, end: 16.0333333 }, 16.0333333)).toBe(true);
    expect(isValidRange({ start: 0, end: 17 }, 16)).toBe(false);
    expect(isValidRange({ start: 5, end: 5.05 }, 16)).toBe(false);
  });
});

describe("px ↔ sec", () => {
  test("round-trips linearly", () => {
    expect(secToPx(4, 16, 800)).toBe(200);
    expect(pxToSec(200, 16, 800)).toBe(4);
    expect(pxToSec(-50, 16, 800)).toBe(0);
    expect(pxToSec(5000, 16, 800)).toBe(16);
    expect(secToPx(4, 0, 800)).toBe(0);
  });

  test("stepTime clamps and rounds", () => {
    expect(stepTime(0, -1 / 30, 16)).toBe(0);
    expect(stepTime(15.99, 1, 16)).toBe(16);
    expect(stepTime(3, 1 / 30, 16)).toBe(3.033);
  });
});

describe("tickMarks", () => {
  test("1 s minors, 5 s labeled majors on a roomy strip", () => {
    const ticks = tickMarks(16, 800);
    expect(ticks[0]).toEqual({ sec: 0, major: true, label: "0:00" });
    expect(ticks.filter((t) => t.major).map((t) => t.sec)).toEqual([0, 5, 10, 15]);
    expect(ticks.length).toBe(17);
  });

  test("coarsens on a dense strip so labels never crowd", () => {
    const ticks = tickMarks(600, 400); // 0.67 px/s
    const majors = ticks.filter((t) => t.major).map((t) => t.sec);
    expect(majors[0]).toBe(0);
    // Label spacing >= 48 px → majors at least 72 s apart.
    for (let i = 1; i < majors.length; i += 1) {
      expect((majors[i]! - majors[i - 1]!) * (400 / 600)).toBeGreaterThanOrEqual(48);
    }
  });

  test("empty for degenerate input", () => {
    expect(tickMarks(0, 800)).toEqual([]);
    expect(tickMarks(16, 0)).toEqual([]);
  });
});
